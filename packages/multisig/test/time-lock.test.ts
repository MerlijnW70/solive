import { createHash } from "node:crypto";
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
} from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { EXIT_OK, EXIT_REFUSED, EXIT_USAGE, MAX_TIME_LOCK } from "../src/main.js";
import { executeInstruction, LOADER, programDataOf, readMultisig, readProposal, vaultOf } from "../src/squads.js";
import { engineProgram, randomAddress, squadsProgram, Svm } from "./svm.js";

let s: Svm;

beforeAll(async () => {
  s = await Svm.open();
});

const LOCK = 3600;

const bytesOf = (key: Address) => new Uint8Array(getAddressEncoder().encode(key));

const header = (tag: number, body: Uint8Array[]) => Uint8Array.from([tag, 0, 0, 0, ...body.flatMap((part) => [...part])]);

function sha256(code: Uint8Array): string {
  let end = code.length;
  while (end > 0 && code[end - 1] === 0) {
    end -= 1;
  }
  return createHash("sha256").update(code.subarray(0, end)).digest("hex");
}

function later(seconds: number): void {
  const clock = s.svm.getClock();
  clock.unixTimestamp = clock.unixTimestamp + BigInt(seconds);
  s.svm.setClock(clock);
}

async function multisig(tag: string) {
  const members = await Promise.all(["a", "b", "c"].map((name) => s.member(`${tag}-${name}.json`)));
  s.keys.set(`${tag}-create.json`, await generateKeyPairSigner());
  const created = await s.cli(
    "create",
    "--members",
    members.map((m) => m.address).join(","),
    "--threshold",
    "2",
    "--keypair",
    `${tag}-a.json`,
    "--create-key",
    `${tag}-create.json`,
    "--yes",
  );
  expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
  const at = address(created.json()["multisig"] as string);
  return { address: at, vault: await vaultOf(at), members, file: (name: string) => `${tag}-${name}.json` };
}

type Made = Awaited<ReturnType<typeof multisig>>;

async function passConfig(m: Made, index: bigint): Promise<void> {
  const on = ["--multisig", m.address, "--index", index.toString(), "--allow-config", "--yes"];
  for (const name of ["a", "b"]) {
    expect((await s.cli("approve", ...on, "--keypair", m.file(name))).code).toBe(EXIT_OK);
  }
}

async function upgradeTarget(vault: Address, code: Uint8Array): Promise<{ program: Address; programData: Address; buffer: Address }> {
  const program = await randomAddress();
  const programData = await programDataOf(program);
  const current = engineProgram();
  const held = new Uint8Array(Math.max(current.length, code.length));
  held.set(current);
  s.set(programData, LOADER, header(3, [new Uint8Array(8), new Uint8Array([1]), bytesOf(vault), held]));
  s.set(program, LOADER, header(2, [bytesOf(programData)]), true);
  const buffer = await randomAddress();
  s.set(buffer, LOADER, header(1, [new Uint8Array([1]), bytesOf(vault), code]));
  return { program, programData, buffer };
}

describe("propose-time-lock", () => {
  it("refuses a time lock above the maximum and a non-member before sending", async () => {
    const m = await multisig("lock-refuse");
    const propose = ["propose-time-lock", "--multisig", m.address, "--yes"];
    const tooLong = await s.cli(...propose, "--seconds", String(MAX_TIME_LOCK + 1), "--keypair", m.file("a"));
    expect([tooLong.code, tooLong.json()["error"]]).toEqual([EXIT_USAGE, `--seconds takes a whole number from 0 to ${MAX_TIME_LOCK}, not ${MAX_TIME_LOCK + 1}`]);
    const fraction = await s.cli(...propose, "--seconds", "1.5", "--keypair", m.file("a"));
    expect(fraction.code).toBe(EXIT_USAGE);
    const missing = await s.cli("propose-time-lock", "--multisig", m.address, "--keypair", m.file("a"));
    expect([missing.code, missing.json()["error"]]).toEqual([EXIT_USAGE, "this command needs --seconds"]);
    const outsider = await s.member("lock-refuse-outsider.json");
    const stranger = await s.cli(...propose, "--seconds", String(LOCK), "--keypair", "lock-refuse-outsider.json");
    expect([stranger.code, stranger.json()]).toEqual([EXIT_REFUSED, { error: `${outsider.address} is not a member of multisig ${m.address}, so it cannot propose`, refused: true }]);
    expect((await readMultisig(s.chain, m.address)).transactionIndex).toBe(0n);
    expect(await readProposal(s.chain, m.address, 1n)).toBeNull();
  });

  it("sets the time lock after two approvals, which then holds back an upgrade and the next time lock change", async () => {
    const m = await multisig("lock");
    s.svm.warpToSlot(10n);
    const propose = ["propose-time-lock", "--multisig", m.address, "--seconds", String(LOCK), "--keypair", m.file("a")];
    const preview = await s.cli(...propose);
    const members = (await readMultisig(s.chain, m.address)).members.map((k) => k.key).join(", ");
    const summary = [
      `Proposes config transaction 1 on multisig ${m.address}; it runs once 2 members approve and the current time lock of 0 seconds passes`,
      `Changes the time lock from 0 to ${LOCK} seconds`,
      `After it runs: members ${members}; threshold 2 of 3; time lock ${LOCK} seconds`,
    ];
    expect(preview.json()).toMatchObject({ sent: false, simulation: "ok", index: "1", time_lock: 0, new_time_lock: LOCK, summary });
    expect(await readProposal(s.chain, m.address, 1n)).toBeNull();
    const proposed = await s.cli(...propose, "--yes");
    expect([proposed.code, proposed.err, proposed.json()["sent"]]).toEqual([EXIT_OK, "", true]);

    const shown = (await s.cli("show", "--multisig", m.address, "--index", "1")).json()["proposals"][0];
    expect(shown).toMatchObject({ kind: "config", status: "active", creator: m.members[0]?.address, actions: [{ __kind: "SetTimeLock", newTimeLock: LOCK }] });
    expect(shown["summary"]).toContain(`Changes the time lock from 0 to ${LOCK} seconds`);

    await passConfig(m, 1n);
    const executed = await s.cli("execute", "--multisig", m.address, "--index", "1", "--allow-config", "--keypair", m.file("c"), "--yes");
    expect([executed.code, executed.err]).toEqual([EXIT_OK, ""]);
    expect((await readMultisig(s.chain, m.address)).timeLock).toBe(LOCK);

    const code = squadsProgram();
    const target = await upgradeTarget(m.vault, code);
    const spill = await randomAddress();
    const upgrade = ["--multisig", m.address, "--program", target.program, "--buffer", target.buffer, "--spill", spill, "--keypair", m.file("a"), "--yes"];
    const upgraded = await s.cli("propose-upgrade", ...upgrade);
    expect([upgraded.code, upgraded.json()["index"]]).toEqual([EXIT_OK, "2"]);
    const hashes = [];
    for (const name of ["a", "b"]) {
      const approved = await s.cli("approve", "--multisig", m.address, "--index", "2", "--keypair", m.file(name), "--yes");
      expect(approved.code).toBe(EXIT_OK);
      hashes.push(approved.json()["buffer_hash"]);
    }
    expect(hashes).toEqual([sha256(code), sha256(code)]);
    const run = ["execute", "--multisig", m.address, "--index", "2", "--keypair", m.file("c"), "--expect-buffer-hash", sha256(code), "--yes"];
    const early = await s.cli(...run);
    expect([early.code, early.json()["error"]]).toEqual([EXIT_REFUSED, expect.stringMatching(new RegExp(`^proposal 2 is time locked for ${LOCK} more seconds, until `))]);

    const executor = m.members[2]!;
    const direct = await executeInstruction(s.chain, { multisig: m.address, member: executor.address, index: 2n });
    const tx = await signTransaction(
      [executor.keyPair],
      compileTransaction(
        pipe(
          createTransactionMessage({ version: 0 }),
          (msg) => setTransactionMessageFeePayer(executor.address, msg),
          (msg) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: s.svm.latestBlockhash(), lastValidBlockHeight: 0n }, msg),
          (msg) => appendTransactionMessageInstructions([direct], msg),
        ),
      ),
    );
    await expect(s.chain.send(tx)).rejects.toThrow(/TimeLockNotReleased|custom program error/);
    expect((await readProposal(s.chain, m.address, 2n))?.status.__kind).toBe("Approved");

    later(LOCK - 1);
    const almost = await s.cli(...run);
    expect(almost.json()["error"]).toMatch(/^proposal 2 is time locked for 1 more seconds, until /);
    later(1);
    const done = await s.cli(...run);
    expect([done.code, done.err]).toEqual([EXIT_OK, ""]);
    const data = s.account(target.programData);
    expect(data.exists && Buffer.from(data.data.subarray(45, 45 + code.length)).equals(Buffer.from(code))).toBe(true);

    const undo = await s.cli("propose-time-lock", "--multisig", m.address, "--seconds", "0", "--keypair", m.file("b"), "--yes");
    expect([undo.code, undo.json()["index"]]).toEqual([EXIT_OK, "3"]);
    expect(undo.json()["summary"][0]).toContain(`the current time lock of ${LOCK} seconds passes`);
    await passConfig(m, 3n);
    const held = await s.cli("execute", "--multisig", m.address, "--index", "3", "--allow-config", "--keypair", m.file("c"), "--yes");
    expect([held.code, held.json()["error"]]).toEqual([EXIT_REFUSED, expect.stringMatching(new RegExp(`^proposal 3 is time locked for ${LOCK} more seconds, until `))]);
    expect((await readMultisig(s.chain, m.address)).timeLock).toBe(LOCK);
  });
});
