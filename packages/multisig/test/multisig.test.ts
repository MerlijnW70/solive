import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase64Decoder,
  type Instruction,
  isSignerRole,
  isWritableRole,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
} from "@solana/kit";
import { buildProposeAdmin, buildRaisePause, PAUSE_FILL } from "@intent-engine/core";
import { beforeAll, describe, expect, it } from "vitest";
import { EXIT_OK, EXIT_REFUSED, NOT_SENT } from "../src/main.js";
import {
  ENGINE_PROGRAM,
  executeInstruction,
  type InstructionView,
  instructionView,
  LOADER,
  messageInstructions,
  programDataOf,
  readVaultTransaction,
  SYSVAR_CLOCK,
  SYSVAR_RENT,
  vaultOf,
} from "../src/squads.js";
import { engineProgram, randomAddress, squadsProgram, Svm } from "./svm.js";

let s: Svm;

beforeAll(async () => {
  s = await Svm.open();
});

const bytesOf = (key: Address) => new Uint8Array(getAddressEncoder().encode(key));

const printedView = (ix: Instruction) => ({
  program: ix.programAddress,
  accounts: (ix.accounts ?? []).map((meta) => ({ address: meta.address, signer: isSignerRole(meta.role), writable: isWritableRole(meta.role) })),
  data: getBase64Decoder().decode(ix.data ?? new Uint8Array()),
});

const printed = (signer: Address, instructions: Instruction[], summary: string[]) =>
  JSON.stringify({
    cluster: { url: "https://api.devnet.solana.com", genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" },
    summary,
    unsigned: {
      signers: [signer],
      fee_payer: signer,
      instructions: instructions.map(printedView),
      next: "import transaction_base58 into the multisig as a proposal",
    },
  });

async function multisig(tag: string, threshold: number, timeLock = 0) {
  const members = await Promise.all(["a", "b", "c"].map((name) => s.member(`${tag}-${name}.json`)));
  const createKey = await generateKeyPairSigner();
  s.keys.set(`${tag}-create.json`, createKey);
  const args = ["create", "--members", members.map((m) => m.address).join(","), "--threshold", String(threshold)];
  const lock = timeLock === 0 ? [] : ["--time-lock", String(timeLock)];
  const keys = ["--keypair", `${tag}-a.json`, "--create-key", `${tag}-create.json`];
  const preview = await s.cli(...args, ...lock, ...keys);
  expect([preview.code, preview.json()["sent"], preview.json()["simulation"], preview.json()["next"]]).toEqual([EXIT_OK, false, "ok", NOT_SENT]);
  const created = await s.cli(...args, ...lock, ...keys, "--yes");
  expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
  const out = created.json();
  const at = address(out["multisig"] as string);
  const vault = await vaultOf(at);
  expect(out).toMatchObject({ sent: true, vault, threshold, time_lock: timeLock });
  return { address: at, vault, members, file: (name: string) => `${tag}-${name}.json` };
}

const paidByVault = (list: InstructionView[], vault: Address): InstructionView[] =>
  list.map((ix) => ({
    ...ix,
    accounts: ix.accounts.map((meta) => (meta.address === vault ? { ...meta, writable: true } : meta)),
  }));

const header = (tag: number, body: Uint8Array[]) => {
  const parts = [new Uint8Array([tag, 0, 0, 0]), ...body];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const base64 = (bytes: number[]) => getBase64Decoder().decode(new Uint8Array(bytes));

describe("multisig", () => {
  it("the upgrade proposal runs the loader upgrade with the vault as authority", async () => {
    const m = await multisig("upgrade", 2);
    const current = engineProgram();
    const next = squadsProgram();
    const programData = await programDataOf(ENGINE_PROGRAM);
    const capacity = Math.max(current.length, next.length);
    const slot = new Uint8Array(8);
    const held = new Uint8Array(capacity);
    held.set(current);
    s.set(programData, LOADER, header(3, [slot, new Uint8Array([1]), bytesOf(m.vault), held]));
    s.set(ENGINE_PROGRAM, LOADER, header(2, [bytesOf(programData)]), true);
    const buffer = await randomAddress();
    const spill = await randomAddress();
    const strangerBuffer = await randomAddress();
    s.set(buffer, LOADER, header(1, [new Uint8Array([1]), bytesOf(m.vault), next]));
    s.set(strangerBuffer, LOADER, header(1, [new Uint8Array([1]), bytesOf(await randomAddress()), next]));
    s.svm.warpToSlot(10n);

    const propose = ["propose-upgrade", "--multisig", m.address, "--spill", spill, "--keypair", m.file("a")];
    const refused = await s.cli(...propose, "--buffer", strangerBuffer, "--yes");
    expect([refused.code, refused.json()["error"]]).toEqual([
      EXIT_REFUSED,
      expect.stringContaining(`not the vault ${m.vault}; run solana program set-buffer-authority`),
    ]);
    const proposed = await s.cli(...propose, "--buffer", buffer, "--yes");
    expect([proposed.code, proposed.err]).toEqual([EXIT_OK, ""]);
    expect(proposed.json()).toMatchObject({ sent: true, index: "1", vault: m.vault });

    const expected = {
      program: LOADER,
      accounts: [
        { address: programData, signer: false, writable: true },
        { address: ENGINE_PROGRAM, signer: false, writable: true },
        { address: buffer, signer: false, writable: true },
        { address: spill, signer: false, writable: true },
        { address: SYSVAR_RENT, signer: false, writable: false },
        { address: SYSVAR_CLOCK, signer: false, writable: false },
        { address: m.vault, signer: true, writable: false },
      ],
      data: base64([3, 0, 0, 0]),
    };
    expect(proposed.json()["instructions"]).toEqual([expected]);
    const stored = await readVaultTransaction(s.chain, m.address, 1n);
    expect(stored?.message.instructions).toHaveLength(1);
    expect(messageInstructions(stored!.message).map(instructionView)).toEqual(paidByVault([expected], m.vault));
    expect(stored!.message.accountKeys[0]).toBe(m.vault);

    for (const member of ["a", "b"]) {
      expect((await s.cli("approve", "--multisig", m.address, "--index", "1", "--keypair", m.file(member), "--yes")).code).toBe(EXIT_OK);
    }
    const before = s.account(buffer);
    expect(before.exists).toBe(true);
    const bufferLamports = before.exists ? before.lamports : 0n;
    const preview = await s.cli("execute", "--multisig", m.address, "--index", "1", "--keypair", m.file("c"));
    expect(preview.json()).toMatchObject({ sent: false, simulation: "ok" });
    const executed = await s.cli("execute", "--multisig", m.address, "--index", "1", "--keypair", m.file("c"), "--yes");
    expect([executed.code, executed.err]).toEqual([EXIT_OK, ""]);

    const upgraded = s.account(programData);
    expect(upgraded.exists).toBe(true);
    const data = upgraded.exists ? upgraded.data : new Uint8Array();
    expect(Buffer.from(data.subarray(4, 12)).readBigUInt64LE(0)).toBe(10n);
    expect(Buffer.from(data.subarray(13, 45)).equals(Buffer.from(bytesOf(m.vault)))).toBe(true);
    expect(Buffer.from(data.subarray(45, 45 + next.length)).equals(Buffer.from(next))).toBe(true);
    expect(s.account(buffer).exists).toBe(false);
    const spilled = s.account(spill);
    expect(spilled.exists ? spilled.lamports : 0n).toBe(bufferLamports);
    const shown = (await s.cli("show", "--multisig", m.address, "--index", "1")).json();
    expect(shown["proposals"][0]).toMatchObject({ status: "executed", approvals: "2 of 2" });

    const successor = await randomAddress();
    const handOver = ["--multisig", m.address, "--keypair", m.file("b"), "--yes"];
    expect((await s.cli("propose-authority", ...handOver, "--new-authority", successor)).code).toBe(EXIT_OK);
    const pending = (await s.cli("show", "--multisig", m.address, "--index", "2")).json();
    expect(pending["proposals"][0]["summary"]).toEqual([`Hands the upgrade authority of program ${ENGINE_PROGRAM} from ${m.vault} to ${successor}`]);
    for (const member of ["b", "c"]) {
      expect((await s.cli("approve", "--multisig", m.address, "--index", "2", "--keypair", m.file(member), "--yes")).code).toBe(EXIT_OK);
    }
    expect((await s.cli("execute", ...handOver, "--index", "2")).code).toBe(EXIT_OK);
    const handed = s.account(programData);
    expect(Buffer.from(handed.exists ? handed.data.subarray(13, 45) : new Uint8Array()).equals(Buffer.from(bytesOf(successor)))).toBe(true);
    const another = await randomAddress();
    s.set(another, LOADER, header(1, [new Uint8Array([1]), bytesOf(m.vault), next]));
    const gone = await s.cli(...propose, "--buffer", another, "--yes");
    expect([gone.code, gone.json()["error"]]).toEqual([EXIT_REFUSED, expect.stringContaining(`is upgraded by ${successor}, not the vault`)]);
  });

  it("an admin proposal wraps exactly the instructions the cli printed", async () => {
    const m = await multisig("admin", 2);
    const raise = await buildRaisePause({ authority: createNoopSigner(m.vault), flags: PAUSE_FILL });
    s.printed = printed(m.vault, [raise], ["Pauses filling for every intent until the admin lowers the pause"]);
    const command = ["intent-engine", "raise-pause", "--authority", m.vault, "--flags", "fill"];
    const runs = s.runs.length;
    const proposed = await s.cli("propose-admin", "--multisig", m.address, "--keypair", m.file("b"), "--yes", "--", ...command);
    expect([proposed.code, proposed.err]).toEqual([EXIT_OK, ""]);
    expect(s.runs.slice(runs)).toEqual([command]);
    const out = proposed.json();
    expect(out).toMatchObject({ sent: true, index: "1", command, summary: expect.arrayContaining(["Pauses filling for every intent until the admin lowers the pause"]) });
    const cliPrinted = (JSON.parse(s.printed) as { unsigned: { instructions: InstructionView[] } }).unsigned.instructions;
    expect(out["instructions"]).toEqual(cliPrinted);
    const stored = await readVaultTransaction(s.chain, m.address, 1n);
    expect(stored).not.toBeNull();
    expect(messageInstructions(stored!.message).map(instructionView)).toEqual(paidByVault(cliPrinted, m.vault));
    expect(stored!.creator).toBe(m.members[1]?.address);

    const other = await randomAddress();
    const foreign = await buildRaisePause({ authority: createNoopSigner(other), flags: PAUSE_FILL });
    s.printed = printed(other, [foreign], []);
    const wrong = await s.cli("propose-admin", "--multisig", m.address, "--keypair", m.file("b"), "--yes", "--", "intent-engine", "raise-pause");
    expect([wrong.code, wrong.json()["error"]]).toEqual([
      EXIT_REFUSED,
      `instruction 0 needs a signature from ${other}, but only the vault ${m.vault} signs; pass --authority ${m.vault} to the command`,
    ]);
    s.printed = JSON.stringify({ sent: false, summary: ["held"] });
    const signed = await s.cli("propose-admin", "--multisig", m.address, "--keypair", m.file("b"), "--", "intent-engine", "raise-pause");
    expect(signed.json()["error"]).toBe("the command printed no unsigned transaction; run an intent engine admin command with --authority <vault>");
    expect((await s.cli("show", "--multisig", m.address)).json()["transaction_index"]).toBe("1");
  });

  it("show decodes a proposal into a readable summary", async () => {
    const m = await multisig("show", 2, 3600);
    const nextAdmin = await randomAddress();
    const propose = await buildProposeAdmin({ admin: createNoopSigner(m.vault), pendingAdmin: nextAdmin });
    s.printed = printed(m.vault, [propose], [`Proposes ${nextAdmin} as the next admin`]);
    const args = ["--multisig", m.address, "--keypair", m.file("a"), "--yes"];
    expect((await s.cli("propose-admin", ...args, "--", "intent-engine", "propose-admin", "--authority", m.vault)).code).toBe(EXIT_OK);
    expect((await s.cli("approve", ...args, "--index", "1")).code).toBe(EXIT_OK);
    const again = await s.cli("approve", ...args, "--index", "1");
    expect(again.json()["error"]).toBe(`${m.members[0]?.address} already approved proposal 1`);

    const shown = await s.cli("show", "--multisig", m.address, "--index", "1");
    expect(shown.code).toBe(EXIT_OK);
    const out = shown.json();
    expect(out).toMatchObject({
      multisig: m.address,
      vault: m.vault,
      threshold: 2,
      time_lock: 3600,
      transaction_index: "1",
    });
    expect(out["members"]).toHaveLength(3);
    expect(out["members"]).toEqual(expect.arrayContaining(m.members.map((k) => ({ address: k.address, permissions: ["initiate", "vote", "execute"] }))));
    expect(out["proposals"]).toHaveLength(1);
    expect(out["proposals"][0]).toMatchObject({
      index: "1",
      status: "active",
      stale: false,
      approvals: "1 of 2",
      approved: [m.members[0]?.address],
      creator: m.members[0]?.address,
      summary: [`Intent engine ProposeAdmin {"pendingAdmin":"${nextAdmin}"}, signed by ${m.vault}`],
    });
    expect(out["proposals"][0]["instructions"][0]).toMatchObject({ program: ENGINE_PROGRAM, accounts: paidByVault([printedView(propose)], m.vault)[0]?.accounts });

    const all = (await s.cli("show", "--multisig", m.address)).json();
    expect(all["proposals"].map((p: { index: string }) => p.index)).toEqual(["1"]);
    const beyond = await s.cli("show", "--multisig", m.address, "--index", "2");
    expect([beyond.code, beyond.json()["error"]]).toEqual([EXIT_REFUSED, `multisig ${m.address} has proposals 1 to 1, not 2`]);
    const notMultisig = await s.cli("show", "--multisig", m.vault);
    expect(notMultisig.json()["error"]).toBe(`${m.vault} is not a Squads v4 multisig`);
  });

  it("execute refuses before the threshold is reached", async () => {
    const m = await multisig("threshold", 2);
    const raise = await buildRaisePause({ authority: createNoopSigner(m.vault), flags: PAUSE_FILL });
    s.printed = printed(m.vault, [raise], []);
    const on = ["--multisig", m.address, "--yes"];
    expect((await s.cli("propose-admin", ...on, "--keypair", m.file("a"), "--", "intent-engine", "raise-pause")).code).toBe(EXIT_OK);
    expect((await s.cli("approve", ...on, "--keypair", m.file("a"), "--index", "1")).code).toBe(EXIT_OK);

    const early = await s.cli("execute", ...on, "--keypair", m.file("b"), "--index", "1");
    expect([early.code, early.json()]).toEqual([EXIT_REFUSED, { error: "proposal 1 has 1 of 2 approvals; it needs 1 more before it can execute", refused: true }]);
    const outsider = await s.member("threshold-outsider.json");
    const stranger = await s.cli("execute", ...on, "--keypair", "threshold-outsider.json", "--index", "1");
    expect(stranger.json()["error"]).toBe(`${outsider.address} is not a member of multisig ${m.address}, so it cannot execute`);
    const missing = await s.cli("execute", ...on, "--keypair", m.file("b"), "--index", "2");
    expect(missing.json()["error"]).toBe(`multisig ${m.address} has no proposal 2`);

    const member = m.members[1]!;
    const instruction = await executeInstruction(s.chain, { multisig: m.address, index: 1n, member: member.address });
    const tx = await signTransaction(
      [member.keyPair],
      compileTransaction(
        pipe(
          createTransactionMessage({ version: 0 }),
          (msg) => setTransactionMessageFeePayer(member.address, msg),
          (msg) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: s.svm.latestBlockhash(), lastValidBlockHeight: 0n }, msg),
          (msg) => appendTransactionMessageInstructions([instruction], msg),
        ),
      ),
    );
    await expect(s.chain.send(tx)).rejects.toThrow(/InvalidProposalStatus|custom program error/);
    const shown = (await s.cli("show", "--multisig", m.address, "--index", "1")).json();
    expect(shown["proposals"][0]).toMatchObject({ status: "active", approvals: "1 of 2" });

    const locked = await multisig("locked", 1, 3600);
    s.printed = printed(locked.vault, [await buildRaisePause({ authority: createNoopSigner(locked.vault), flags: PAUSE_FILL })], []);
    const lockedOn = ["--multisig", locked.address, "--keypair", locked.file("a"), "--yes"];
    expect((await s.cli("propose-admin", ...lockedOn, "--", "intent-engine", "raise-pause")).code).toBe(EXIT_OK);
    expect((await s.cli("approve", ...lockedOn, "--index", "1")).code).toBe(EXIT_OK);
    const waiting = await s.cli("execute", ...lockedOn, "--index", "1");
    expect([waiting.code, waiting.json()["error"]]).toEqual([EXIT_REFUSED, expect.stringMatching(/^proposal 1 is time locked for 3600 more seconds, until /)]);
  });
});
