import { createHash, getRandomValues } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromPrivateKeyBytes,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase58Decoder,
  type Instruction,
  isSignerRole,
  isWritableRole,
  type KeyPairSigner,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signBytes,
} from "@solana/kit";
import { buildRaisePause, PAUSE_FILL } from "@intent-engine/core/internal";
import { beforeAll, describe, expect, it } from "vitest";
import { readSigner } from "../src/keys.js";
import { proposalApprove, proposalPda } from "../src/layout.js";
import { LEDGER_ERRORS, LEDGER_FORMS, type LedgerTransport, type OpenTransport, parseLedgerPath } from "../src/ledger.js";
import { type Deps, EXIT_OK, EXIT_REFUSED, EXIT_USAGE, main } from "../src/main.js";
import { Svm } from "./svm.js";

type Store = { passed: number; ensureQueueEmpty(): void };
type Mocker = {
  RecordStore: new (queue: [string, string][]) => Store;
  openTransportReplayer(store: Store): Promise<LedgerTransport>;
};

const load = createRequire(import.meta.url);
const mocker = load("@ledgerhq/hw-transport-mocker") as Mocker;
const { TransportError } = load("@ledgerhq/hw-transport/errors") as { TransportError: new (message: string, id: string) => Error };

const OK = "9000";
const HARDENED = 0x80000000;
const MAX_PAYLOAD = 255;
const CONFIG = "e004000000";
const BLIND_ON = `0100010309${OK}`;
const BLIND_OFF = `0000010309${OK}`;

let s: Svm;

beforeAll(async () => {
  s = await Svm.open();
});

const hex = (bytes: Iterable<number>) => Buffer.from([...bytes]).toString("hex");

const pathBytes = (levels: number[]) => [
  levels.length,
  ...levels.flatMap((n) => {
    const word = (n | HARDENED) >>> 0;
    return [word >>> 24, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff];
  }),
];

const apdu = (ins: number, p1: number, p2: number, data: number[]) => hex([0xe0, ins, p1, p2, data.length, ...data]);

const addressApdu = (levels: number[], key: Address): [string, string] => [apdu(0x05, 0, 0, pathBytes(levels)), `${hex(getAddressEncoder().encode(key))}${OK}`];

function signApdus(levels: number[], message: Uint8Array, last: string): [string, string][] {
  const payload = [1, ...pathBytes(levels), ...message];
  const out: [string, string][] = [];
  let p2 = 0;
  let at = 0;
  while (payload.length - at > MAX_PAYLOAD) {
    out.push([apdu(0x06, 1, p2 | 0x02, payload.slice(at, at + MAX_PAYLOAD)), OK]);
    at += MAX_PAYLOAD;
    p2 |= 0x01;
  }
  out.push([apdu(0x06, 1, p2, payload.slice(at)), last]);
  return out;
}

const messageOf = (payer: Address, instructions: Instruction[]) =>
  new Uint8Array(
    compileTransaction(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(payer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: s.svm.latestBlockhash(), lastValidBlockHeight: 0n }, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
      ),
    ).messageBytes,
  );

const hashOf = (message: Uint8Array) => getBase58Decoder().decode(createHash("sha256").update(message).digest());

const signed = async (key: KeyPairSigner, message: Uint8Array) => `${hex(await signBytes(key.keyPair.privateKey, message))}${OK}`;

type Device = { store: Store; opened: number; notes: { text: string; passed: number }[]; deps: Deps };

function device(queue: [string, string][], open?: OpenTransport): Device {
  const store = new mocker.RecordStore(queue);
  const made: Device = { store, opened: 0, notes: [], deps: s.deps };
  const replay: OpenTransport = async () => {
    made.opened += 1;
    return mocker.openTransportReplayer(store);
  };
  made.deps = {
    ...s.deps,
    keypair: (path) => (path.startsWith("usb://") ? readSigner(path, open ?? replay) : s.deps.keypair(path)),
    notify: (text) => made.notes.push({ text, passed: store.passed }),
  };
  return made;
}

async function proposed(tag: string, ledger: Address) {
  const [b, c] = await Promise.all(["b", "c"].map((name) => s.member(`${tag}-${name}.json`)));
  s.keys.set(`${tag}-create.json`, await generateKeyPairSigner());
  const members = [ledger, b!.address, c!.address].join(",");
  const created = await s.cli("create", "--members", members, "--threshold", "2", "--keypair", `${tag}-b.json`, "--create-key", `${tag}-create.json`, "--yes");
  expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
  const multisig = created.json()["multisig"] as Address;
  const vault = created.json()["vault"] as Address;
  const raise = await buildRaisePause({ authority: createNoopSigner(vault), flags: PAUSE_FILL });
  s.printed = JSON.stringify({
    summary: [],
    unsigned: {
      signers: [vault],
      fee_payer: vault,
      instructions: [raise].map((ix) => ({
        program: ix.programAddress,
        accounts: (ix.accounts ?? []).map((meta) => ({ address: meta.address, signer: isSignerRole(meta.role), writable: isWritableRole(meta.role) })),
        data: Buffer.from(ix.data ?? []).toString("base64"),
      })),
    },
  });
  const made = await s.cli("propose-admin", "--multisig", multisig, "--keypair", `${tag}-b.json`, "--yes", "--", "intent-engine", "raise-pause");
  expect([made.code, made.err]).toEqual([EXIT_OK, ""]);
  return { multisig, approve: ["approve", "--multisig", multisig, "--index", "1"] };
}

const approvedBy = async (multisig: Address) => (await s.cli("show", "--multisig", multisig, "--index", "1")).json()["proposals"][0]["approved"] as Address[];

async function approval(tag: string, last?: string) {
  const key = await s.member(`${tag}-ledger.json`);
  const { multisig, approve } = await proposed(tag, key.address);
  const levels = [44, 501, 1, 0];
  const message = messageOf(key.address, [proposalApprove({ multisig, proposal: await proposalPda(multisig, 1n), member: key.address })]);
  const sign = signApdus(levels, message, last ?? (await signed(key, message)));
  const ledger = device([[CONFIG, BLIND_ON], addressApdu(levels, key.address), [CONFIG, BLIND_ON], ...sign]);
  const result = await main([...approve, "--keypair", "usb://ledger?key=1/0", "--yes"], ledger.deps);
  return { key, multisig, message, ledger, result, signs: sign.length };
}

describe("multisig", () => {
  it("a ledger path parses account and change", () => {
    expect(parseLedgerPath("usb://ledger")).toEqual({ derivation: "44'/501'" });
    expect(parseLedgerPath("usb://ledger?key=0")).toEqual({ account: 0, derivation: "44'/501'/0'" });
    expect(parseLedgerPath("usb://ledger?key=7")).toEqual({ account: 7, derivation: "44'/501'/7'" });
    expect(parseLedgerPath("usb://ledger?key=3/1")).toEqual({ account: 3, change: 1, derivation: "44'/501'/3'/1'" });
    expect(parseLedgerPath("usb://ledger?key=2147483647/2147483647")).toEqual({
      account: 2147483647,
      change: 2147483647,
      derivation: "44'/501'/2147483647'/2147483647'",
    });
  });

  it("an invalid ledger path is refused", async () => {
    const bad = [
      "usb://",
      "usb://ledger/",
      "usb://trezor",
      "usb://ledger?key=",
      "usb://ledger?key=x",
      "usb://ledger?key=-1",
      "usb://ledger?key=01",
      "usb://ledger?key=1/2/3",
      "usb://ledger?key=2147483648",
      "usb://ledger?account=1",
      "usb://ledger?key=1'",
      "usb://ledger/BvFwPu5PBPCBz4fWmtnfX3cHqKoUHhzuuPrEh4rKpsy?key=0",
    ];
    await s.member("ledger-invalid.json");
    for (const path of bad) {
      expect(() => parseLedgerPath(path)).toThrow(LEDGER_FORMS.join(", "));
      for (const flag of ["--keypair", "--create-key"]) {
        const ledger = device([]);
        const args = flag === "--keypair" ? ["--keypair", path] : ["--keypair", "ledger-invalid.json", "--create-key", path];
        const result = await main(["create", "--members", (await generateKeyPairSigner()).address, "--threshold", "1", ...args], ledger.deps);
        expect(result.code).toBe(EXIT_USAGE);
        const err = JSON.parse(result.err) as { error: string; usage: string[] };
        expect(err.error).toBe(`${flag} ${path} ${path.startsWith("usb://ledger?key=2147483648") ? "names an index above 2147483647" : "is not a Ledger path"}; use ${LEDGER_FORMS.join(", ")}`);
        expect(err.usage.join("\n")).toContain(LEDGER_FORMS.join(", "));
        expect(ledger.opened).toBe(0);
      }
    }
  });

  it("approve signs with a ledger through its transport", async () => {
    const { key, multisig, ledger, result } = await approval("ledger-approve");
    expect([result.code, JSON.parse(result.out)]).toEqual([EXIT_OK, expect.objectContaining({ sent: true, approvals: 1, threshold: 2 })]);
    ledger.store.ensureQueueEmpty();
    expect(ledger.opened).toBe(2);
    expect(await approvedBy(multisig)).toEqual([key.address]);
    const again = device([[CONFIG, BLIND_ON], addressApdu([44, 501, 1, 0], key.address)]);
    const preview = await main(["approve", "--multisig", multisig, "--index", "1", "--keypair", "usb://ledger?key=1/0"], again.deps);
    expect([preview.code, JSON.parse(preview.err)["error"]]).toEqual([EXIT_REFUSED, `${key.address} already approved proposal 1`]);
    again.store.ensureQueueEmpty();
  });

  it("the printed message hash is the one the ledger shows", async () => {
    const { message, ledger, result } = await approval("ledger-hash");
    expect(result.code).toBe(EXIT_OK);
    const hash = hashOf(message);
    expect(JSON.parse(result.out)["message_hash"]).toBe(hash);
    expect(ledger.notes).toHaveLength(1);
    const [note] = ledger.notes;
    expect(note!.passed).toBe(2);
    expect(note!.text).toContain(`message hash: ${hash}`);
    expect(note!.text).toContain("usb://ledger?key=1/0 will ask to sign a message hash: compare it with " + hash + " on the device screen and press approve only if it matches");
    expect(note!.text).toContain(JSON.parse(result.out)["summary"][0]);
    expect(result.err).toBe("");
  });

  it("a ledger that is not a member is refused before it is asked to sign", async () => {
    const stranger = await s.member("ledger-stranger.json");
    const member = await generateKeyPairSigner();
    const { multisig, approve } = await proposed("ledger-stranger", member.address);
    for (const yes of [[], ["--yes"]]) {
      const ledger = device([[CONFIG, BLIND_ON], addressApdu([44, 501, 0], stranger.address)]);
      const result = await main([...approve, "--keypair", "usb://ledger?key=0", ...yes], ledger.deps);
      expect([result.code, JSON.parse(result.err)["error"]]).toEqual([EXIT_REFUSED, `${stranger.address} is not a member of multisig ${multisig}, so it cannot approve`]);
      ledger.store.ensureQueueEmpty();
      expect([ledger.store.passed, ledger.opened, ledger.notes]).toEqual([2, 1, []]);
    }
    expect(await approvedBy(multisig)).toEqual([]);
  });

  it("a rejection on the ledger sends nothing", async () => {
    const { multisig, ledger, result, signs } = await approval("ledger-reject", "6985");
    expect([result.code, JSON.parse(result.err)["error"]]).toEqual([EXIT_REFUSED, LEDGER_ERRORS.rejected]);
    ledger.store.ensureQueueEmpty();
    expect(ledger.store.passed).toBe(3 + signs);
    expect(ledger.notes).toHaveLength(1);
    expect(result.out).toBe("");
    expect(await approvedBy(multisig)).toEqual([]);
  });

  it("a ledger without the solana app open is reported plainly", async () => {
    const member = await generateKeyPairSigner();
    const { multisig, approve } = await proposed("ledger-app", member.address);
    for (const status of ["6e01", "6e00", "6d00", "6511"]) {
      const ledger = device([[CONFIG, status]]);
      const result = await main([...approve, "--keypair", "usb://ledger", "--yes"], ledger.deps);
      expect([result.code, JSON.parse(result.err)["error"]]).toEqual([EXIT_REFUSED, LEDGER_ERRORS.noApp]);
      ledger.store.ensureQueueEmpty();
    }
    expect(LEDGER_ERRORS.noApp).toBe("the Solana app is not open on the Ledger: open it and run the command again; nothing was sent");
    expect(await approvedBy(multisig)).toEqual([]);
  });

  it("every ledger failure has its own plain message and sends nothing", async () => {
    const key = await s.member("ledger-fail-ledger.json");
    const { multisig, approve } = await proposed("ledger-fail", key.address);
    const levels = [44, 501, 0];
    const message = messageOf(key.address, [proposalApprove({ multisig, proposal: await proposalPda(multisig, 1n), member: key.address })]);
    const found = [[CONFIG, BLIND_ON], addressApdu(levels, key.address)] as [string, string][];
    const missing: OpenTransport = async () => {
      throw new TransportError("NoDevice", "NoDevice");
    };
    const unbuilt: OpenTransport = async () => {
      throw new Error("Could not locate the bindings file. Tried:\n → node_modules/node-hid/build/Release/HID_hidraw.node");
    };
    const cases: [string, Device][] = [
      [LEDGER_ERRORS.notFound, device([], missing)],
      [LEDGER_ERRORS.driver, device([], unbuilt)],
      [LEDGER_ERRORS.locked, device([[CONFIG, "5515"]])],
      [LEDGER_ERRORS.blindSigning, device([...found, [CONFIG, BLIND_OFF]])],
      [LEDGER_ERRORS.blindSigning, device([...found, [CONFIG, BLIND_ON], ...signApdus(levels, message, "6808")])],
      [LEDGER_ERRORS.rejected, device([...found, [CONFIG, BLIND_ON], ...signApdus(levels, message, "6985")])],
      ["the Ledger returned a signature that does not verify for " + key.address + "; nothing was sent", device([...found, [CONFIG, BLIND_ON], ...signApdus(levels, message, `${"11".repeat(64)}${OK}`)])],
    ];
    for (const [error, ledger] of cases) {
      const result = await main([...approve, "--keypair", "usb://ledger?key=0", "--yes"], ledger.deps);
      expect([result.code, JSON.parse(result.err)["error"], result.out]).toEqual([EXIT_REFUSED, error, ""]);
      ledger.store.ensureQueueEmpty();
    }
    expect(new Set(Object.values(LEDGER_ERRORS)).size).toBe(Object.keys(LEDGER_ERRORS).length);
    expect(await approvedBy(multisig)).toEqual([]);
  });

  it("a ledger failure from another copy of the client is still a refusal, told by its error code", async () => {
    const member = await generateKeyPairSigner();
    const { multisig, approve } = await proposed("ledger-copy", member.address);
    const foreign = Object.assign(new Error(LEDGER_ERRORS.notFound), { name: "LedgerError", code: "ledger-error", [Symbol.for("@intent-engine/sdk-error")]: true });
    const deps: Deps = {
      ...s.deps,
      keypair: async (path) => {
        if (path.startsWith("usb://")) {
          throw foreign;
        }
        return s.deps.keypair(path);
      },
    };
    const result = await main([...approve, "--keypair", "usb://ledger", "--yes"], deps);
    expect([result.code, JSON.parse(result.err), result.out]).toEqual([EXIT_REFUSED, { error: LEDGER_ERRORS.notFound, refused: true }, ""]);
    expect(await approvedBy(multisig)).toEqual([]);
  });

  it("file keys never load the ledger transport", async () => {
    const usb = /[\\/](@ledgerhq[\\/](hw-transport-node-hid-noevents|hw-app-solana)|node-hid)[\\/]/;
    const loaded = () => Object.keys(load.cache).filter((path) => usb.test(path));
    for (const path of loaded()) {
      delete load.cache[path];
    }
    const seed = getRandomValues(new Uint8Array(32));
    const key = await createKeyPairSignerFromPrivateKeyBytes(seed);
    s.fund(key.address);
    const file = join(mkdtempSync(join(tmpdir(), "multisig-ledger-")), "member.json");
    writeFileSync(file, JSON.stringify([...seed, ...getAddressEncoder().encode(key.address)]));
    const { multisig, approve } = await proposed("ledger-file", key.address);
    let opened = 0;
    const deps: Deps = {
      ...s.deps,
      keypair: (path) =>
        readSigner(path, async () => {
          opened += 1;
          throw new Error("opened");
        }),
    };
    const preview = await main([...approve, "--keypair", file], deps);
    expect([preview.code, JSON.parse(preview.out)["simulation"]]).toEqual([EXIT_OK, "ok"]);
    const result = await main([...approve, "--keypair", file, "--yes"], { ...s.deps, keypair: (path) => readSigner(path) });
    expect([result.code, result.err]).toEqual([EXIT_OK, ""]);
    expect(await approvedBy(multisig)).toEqual([key.address]);
    expect([opened, loaded()]).toEqual([0, []]);
  });
});
