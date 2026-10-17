import { createPrivateKey, getRandomValues, type KeyObject, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  type Address,
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressEncoder,
  getBase58Decoder,
  getBase64Encoder,
  getTransactionDecoder,
  lamports,
} from "@solana/kit";
import { getTokenDecoder } from "@solana-program/token";
import { beforeEach, describe, expect, it } from "vitest";
import { findIntentPda, getIntentDecoder, IntentStatus } from "@intent-engine/core";
import { LEDGER_ERRORS, LEDGER_FORMS, type LedgerTransport, type OpenTransport } from "@intent-engine/client";
import { ENV_KEYPAIR } from "../src/clusters.js";
import { parse } from "../src/args.js";
import { LEDGER_COMMANDS, needsKeyFile, signsOnDevice } from "../src/ledger-keys.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, main } from "../src/main.js";
import { ata, balance, h, runtime, type World, world } from "./harness.js";

type Store = { passed: number; queue: [string, string][]; replayExchange(apdu: Buffer): Buffer; ensureQueueEmpty(): void };
type Mocker = {
  RecordStore: new (queue: [string, string][]) => Store;
  openTransportReplayer(store: Store): Promise<LedgerTransport>;
};

const load = createRequire(import.meta.url);
const mocker = load("@ledgerhq/hw-transport-mocker") as Mocker;
const { TransportError } = load("@ledgerhq/hw-transport/errors") as { TransportError: new (message: string, id: string) => Error };

const OK = "9000";
const REJECT = "6985";
const SIGN = "sign";
const HARDENED = 0x80000000;
const MORE = 0x02;
const CONFIG = "e004000000";
const BLIND_ON = `0100010309${OK}`;
const BLIND_OFF = `0000010309${OK}`;
const PKCS8_ED25519 = "302e020100300506032b657004220420";
const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));


const hex = (bytes: Iterable<number>) => Buffer.from([...bytes]).toString("hex");

const pathBytes = (levels: number[]) => [
  levels.length,
  ...levels.flatMap((n) => {
    const word = (n | HARDENED) >>> 0;
    return [word >>> 24, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff];
  }),
];

const addressApdu = (levels: number[], key: Address): [string, string] => [
  hex([0xe0, 0x05, 0, 0, pathBytes(levels).length, ...pathBytes(levels)]),
  `${hex(getAddressEncoder().encode(key))}${OK}`,
];

type Key = { address: Address; secret: KeyObject };

async function deviceKey(): Promise<Key> {
  const seed = getRandomValues(new Uint8Array(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const secret = createPrivateKey({ key: Buffer.concat([Buffer.from(PKCS8_ED25519, "hex"), seed]), format: "der", type: "pkcs8" });
  return { address: signer.address, secret };
}

type Device = { store: Store; opened: number; paths: number[][]; signatures: string[]; open: OpenTransport };

function device(key: Key, queue: [string, string][], open?: OpenTransport): Device {
  const store = new mocker.RecordStore(queue);
  const made: Device = { store, opened: 0, paths: [], signatures: [], open: async () => mocker.openTransportReplayer(store) };
  const replay = store.replayExchange.bind(store);
  let chunks: number[] = [];
  store.replayExchange = (apdu: Buffer) => {
    if (apdu[1] !== 0x06 || store.queue[0]?.[0] !== SIGN) {
      return replay(apdu);
    }
    chunks.push(...apdu.subarray(5));
    if (((apdu[3] ?? 0) & MORE) !== 0) {
      return Buffer.from(OK, "hex");
    }
    const payload = Buffer.from(chunks);
    chunks = [];
    const [, answer] = store.queue.shift() ?? [SIGN, OK];
    store.passed += 1;
    const depth = payload[1] ?? 0;
    const path = Array.from({ length: depth }, (_, i) => (payload.readUInt32BE(2 + 4 * i) & ~HARDENED) >>> 0);
    made.paths.push(path);
    if (answer !== OK) {
      return Buffer.from(answer, "hex");
    }
    const signature = sign(null, payload.subarray(2 + 4 * depth), key.secret);
    made.signatures.push(getBase58Decoder().decode(signature));
    return Buffer.from(`${hex(signature)}${OK}`, "hex");
  };
  made.open = async () => {
    made.opened += 1;
    return open === undefined ? mocker.openTransportReplayer(store) : open();
  };
  return made;
}

const signing = (levels: number[], key: Key, answers: string[] = [OK]): [string, string][] => [
  [CONFIG, BLIND_ON],
  addressApdu(levels, key.address),
  ...answers.flatMap((answer): [string, string][] => [
    [CONFIG, BLIND_ON],
    [SIGN, answer],
  ]),
];

async function run(argv: string[], ledger?: Device) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { ...runtime({}), ...(ledger === undefined ? {} : { ledger: ledger.open }) }, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join("\n"), err: err.join("\n"), json: () => JSON.parse(out.join("\n")) as Record<string, unknown> };
}

const allowance = (account: Address) => {
  const view = h.svm.getAccount(account);
  return view.exists ? getTokenDecoder().decode(view.data).delegatedAmount : -1n;
};

const statusOf = (intent: Address) => {
  const view = h.svm.getAccount(intent);
  return view.exists ? getIntentDecoder().decode(view.data).status : undefined;
};

const lastWireSignature = (key: Key) => {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(h.wires.at(-1) ?? ""));
  const signature = tx.signatures[key.address];
  return signature === null || signature === undefined ? null : getBase58Decoder().decode(signature);
};

describe("signing with a Ledger", () => {
  let w: World;
  let key: Key;
  let input: Address;

  beforeEach(async () => {
    w = await world();
    key = await deviceKey();
    h.svm.airdrop(key.address, lamports(10_000_000_000n));
    input = await ata(w.authority, key.address, w.inputMint, 1_000n);
    await ata(w.authority, key.address, w.outputMint);
  });

  const approve = (path: string, amount = "5") => ["approve", "--keypair", path, "--mint", w.inputMint, "--amount", amount, "--units", "raw", "--yes"];

  it("creates and cancels an escrow with the device's signature", async () => {
    const levels = [44, 501, 1, 0];
    const create = [
      "create",
      "swap",
      "--keypair",
      "usb://ledger?key=1/0",
      "--input-mint",
      w.inputMint,
      "--output-mint",
      w.outputMint,
      "--expires-in",
      "3600",
      "--units",
      "raw",
      "--amount-in",
      "400",
      "--min-out",
      "300",
      "--yes",
    ];
    const creating = device(key, signing(levels, key));
    const made = await run(create, creating);
    expect([made.code, made.err]).toEqual([EXIT_OK, ""]);
    creating.store.ensureQueueEmpty();
    expect(creating.paths).toEqual([levels]);
    expect(made.json()).toMatchObject({ sent: true, signatures: creating.signatures });
    expect(lastWireSignature(key)).toBe(creating.signatures[0]);
    expect(balance(input)).toBe(600n);
    const [intent] = await findIntentPda({ owner: key.address, nonce: 0n });
    expect(statusOf(intent)).toBe(IntentStatus.Open);

    const cancelling = device(key, signing(levels, key));
    const cancelled = await run(["cancel", "--keypair", "usb://ledger?key=1/0", "--nonce", "0", "--yes"], cancelling);
    expect([cancelled.code, cancelled.err]).toEqual([EXIT_OK, ""]);
    cancelling.store.ensureQueueEmpty();
    expect(cancelling.paths).toEqual([levels]);
    expect(cancelled.json()).toMatchObject({ intent, sent: true, signature: cancelling.signatures[0] });
    expect(statusOf(intent)).toBe(IntentStatus.Cancelled);
    expect(balance(input)).toBe(1_000n);
  });

  it("each path form picks its derivation", async () => {
    const forms: [string, number[]][] = [
      ["usb://ledger", [44, 501]],
      ["usb://ledger?key=3", [44, 501, 3]],
      ["usb://ledger?key=3/1", [44, 501, 3, 1]],
    ];
    expect(forms.map(([path]) => path.replace(/\d+/g, "<n>"))).toEqual(LEDGER_FORMS.map((form) => form.replace(/<\w+>/g, "<n>")));
    for (const [i, [path, levels]] of forms.entries()) {
      const ledger = device(key, signing(levels, key));
      const result = await run(approve(path, String(i + 1)), ledger);
      expect([result.code, result.err]).toEqual([EXIT_OK, ""]);
      ledger.store.ensureQueueEmpty();
      expect(ledger.paths).toEqual([levels]);
      expect(lastWireSignature(key)).toBe(ledger.signatures[0]);
      expect(allowance(input)).toBe(BigInt(i + 1));
    }
  });

  it("every Ledger failure and a rejection give the plain message and send nothing", async () => {
    const levels = [44, 501, 0];
    const missing: OpenTransport = async () => {
      throw new TransportError("NoDevice", "NoDevice");
    };
    const unbuilt: OpenTransport = async () => {
      throw new Error("Could not locate the bindings file. Tried:\n → node_modules/node-hid/build/Release/HID_hidraw.node");
    };
    const found: [string, string][] = [[CONFIG, BLIND_ON], addressApdu(levels, key.address)];
    const cases: [string, Device][] = [
      [LEDGER_ERRORS.notFound, device(key, [], missing)],
      [LEDGER_ERRORS.driver, device(key, [], unbuilt)],
      [LEDGER_ERRORS.locked, device(key, [[CONFIG, "5515"]])],
      [LEDGER_ERRORS.noApp, device(key, [[CONFIG, "6e01"]])],
      [LEDGER_ERRORS.blindSigning, device(key, [...found, [CONFIG, BLIND_OFF]])],
      [LEDGER_ERRORS.rejected, device(key, signing(levels, key, [REJECT]))],
    ];
    for (const [error, ledger] of cases) {
      const wires = h.wires.length;
      const result = await run(approve("usb://ledger?key=0"), ledger);
      expect([result.code, result.err, result.out]).toEqual([EXIT_FAILED, error, ""]);
      ledger.store.ensureQueueEmpty();
      expect(ledger.signatures).toEqual([]);
      expect(h.wires.length).toBe(wires);
      expect(allowance(input)).toBe(0n);
    }
    const made = device(key, signing(levels, key));
    const create = ["create", "swap", "--keypair", "usb://ledger?key=0", "--input-mint", w.inputMint, "--output-mint", w.outputMint];
    expect((await run([...create, "--expires-in", "3600", "--units", "raw", "--amount-in", "400", "--min-out", "300", "--yes"], made)).code).toBe(EXIT_OK);
    const [intent] = await findIntentPda({ owner: key.address, nonce: 0n });
    const rejecting = device(key, signing(levels, key, [REJECT]));
    const refused = await run(["cancel", "--keypair", "usb://ledger?key=0", "--nonce", "0", "--yes"], rejecting);
    expect([refused.code, refused.err, refused.out]).toEqual([EXIT_FAILED, LEDGER_ERRORS.rejected, ""]);
    rejecting.store.ensureQueueEmpty();
    expect(statusOf(intent)).toBe(IntentStatus.Open);
    expect(balance(input)).toBe(600n);
  });

  it("a command that also signs messages refuses a Ledger path before reading the chain", async () => {
    const refused: [string, string[]][] = [
      ["crank", ["crank", "--keypair", "usb://ledger"]],
      ["balance", ["balance", "--keypair", "usb://ledger?key=2"]],
      ["setup", ["setup", "--keypair", "usb://ledger"]],
      ["profile close", ["profile", "close", "--keypair", "usb://ledger"]],
      ["claims open", ["claims", "open", "--keypair", "usb://ledger", "--nonce", "0", "--max-secs", "60", "--stake", "1"]],
      ["record-delivery", ["record-delivery", "--keypair", "usb://ledger", "--owner", w.owner.address, "--nonce", "0", "--sha256", "ab".repeat(32)]],
      ["signed submit", ["signed", "submit", "--keypair", "usb://ledger", "--file", "signed.json"]],
    ];
    for (const [name, argv] of refused) {
      const ledger = device(key, []);
      h.urls.length = 0;
      const result = await run(argv, ledger);
      const path = argv[argv.indexOf("--keypair") + 1] ?? "";
      expect([result.code, result.err, result.out]).toEqual([EXIT_USAGE, needsKeyFile(name, path), ""]);
      expect(result.err).toContain(`${name} needs a key file`);
      expect(result.err).toContain("because it also signs messages");
      expect([ledger.opened, h.urls]).toEqual([0, []]);
    }
    h.env[ENV_KEYPAIR] = "usb://ledger";
    const ledger = device(key, []);
    const defaulted = await run(["crank"], ledger);
    expect([defaulted.code, defaulted.err]).toEqual([EXIT_USAGE, needsKeyFile("crank", "usb://ledger")]);
    expect([ledger.opened, h.urls]).toEqual([0, []]);
  });

  it("a malformed Ledger path is a usage error that never opens the device or reads a key file", async () => {
    for (const path of ["usb://ledger?key=x", "usb://trezor", "usb://ledger?key=2147483648"]) {
      const ledger = device(key, []);
      h.urls.length = 0;
      const result = await run(approve(path), ledger);
      expect(result.code).toBe(EXIT_USAGE);
      expect(result.err).toContain(`--keypair ${path}`);
      expect(result.err).toContain(LEDGER_FORMS.join(", "));
      expect([ledger.opened, h.urls]).toEqual([0, []]);
    }
  });

  it("only the commands that just sign transactions take a Ledger", () => {
    const owner = w.owner.address;
    const signs = [
      ["cancel", "--nonce", "0"],
      ["expire", "--owner", owner, "--nonce", "0"],
      ["close", "--owner", owner, "--nonce", "0"],
      ["advance-nonce", "--base", "1"],
      ["advance-epoch"],
      ["approve", "--mint", w.inputMint, "--amount", "1"],
      ["revoke-approval", "--mint", w.inputMint],
      ["deliver", "--intent", owner, "--sha256", "ab".repeat(32), "--work-url", "https://" + "example.org/work"],
      ["claims", "take", "--owner", owner, "--nonce", "0", "--secs", "60"],
      ["claims", "drop", "--owner", owner, "--nonce", "0"],
      ["mandate", "revoke", "--agent", owner],
    ];
    for (const argv of signs) {
      expect(signsOnDevice(parse([...argv, "--keypair", "usb://ledger"])), argv.join(" ")).toBe(true);
    }
    for (const argv of [["crank"], ["claims", "open", "--nonce", "0", "--max-secs", "60", "--stake", "1"], ["claims", "settle", "--owner", owner, "--nonce", "0"]]) {
      expect(signsOnDevice(parse([...argv, "--keypair", "usb://ledger"])), argv.join(" ")).toBe(false);
    }
  });

  it("the quickstart names every Ledger form and every command that takes one, in at most three sentences", () => {
    const page = readFileSync(`${ROOT}/docs/quickstart.md`, "utf8");
    const section = /^## Sign with a Ledger\n\n([\s\S]*?)\n\n## /m.exec(page)?.[1] ?? "";
    expect(section).not.toBe("");
    for (const form of LEDGER_FORMS) {
      expect(section).toContain(form === LEDGER_FORMS[0] ? `\`--keypair ${form}\`` : `\`${form}\``);
    }
    const named = [...section.matchAll(/`([a-z-]+(?: [a-z]+)?)`/g)].map((m) => m[1]);
    expect(named).toEqual(LEDGER_COMMANDS);
    expect(section.split(/\.\s/).length).toBeLessThanOrEqual(3);
  });
});
