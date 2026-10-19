import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccountRole,
  type Address,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase64Decoder,
  getU64Encoder,
  type Instruction,
  isSignerRole,
  isWritableRole,
  type KeyPairSigner,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
} from "@solana/kit";
import { buildProposeAdmin, buildRaisePause, buildSetCapsRequired, buildSetMintCap, findMintCapAddress, PAUSE_FILL } from "@intent-engine/core";
import { beforeAll, describe, expect, it } from "vitest";
import type { Chain } from "../src/chain.js";
import { readKeypair } from "../src/keys.js";
import { describeInstructions } from "../src/review.js";
import {
  compileVaultMessage,
  type ConfigAction,
  configTransactionCreate,
  encodeAccount,
  proposalApprove,
  proposalCreate,
  proposalPda,
  SQUADS_PROGRAM,
  SYSTEM_PROGRAM,
  transactionPda,
  vaultTransactionCodec,
  vaultTransactionCreate,
} from "../src/layout.js";
import { EXIT_OK, EXIT_REFUSED, EXIT_USAGE, main, NOT_SENT } from "../src/main.js";
import {
  ENGINE_PROGRAM,
  executeInstruction,
  type InstructionView,
  instructionView,
  LOADER,
  messageInstructions,
  programDataOf,
  readMultisig,
  readVaultTransaction,
  SYSVAR_CLOCK,
  SYSVAR_RENT,
  upgradeInstruction,
  vaultOf,
} from "../src/squads.js";
import { engineProgram, randomAddress, SOL, squadsProgram, Svm } from "./svm.js";

const SQUADS_SITE = ["https:", "", "app.squads.so"].join("/");

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

const sha256 = (code: Uint8Array) => {
  let end = code.length;
  while (end > 0 && code[end - 1] === 0) {
    end -= 1;
  }
  return createHash("sha256").update(code.subarray(0, end)).digest("hex");
};

async function sendAs(payer: KeyPairSigner, instructions: Instruction[]): Promise<void> {
  const tx = await signTransaction(
    [payer.keyPair],
    compileTransaction(
      pipe(
        createTransactionMessage({ version: 0 }),
        (msg) => setTransactionMessageFeePayer(payer.address, msg),
        (msg) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: s.svm.latestBlockhash(), lastValidBlockHeight: 0n }, msg),
        (msg) => appendTransactionMessageInstructions(instructions, msg),
      ),
    ),
  );
  await s.chain.send(tx);
}

type Made = Awaited<ReturnType<typeof multisig>>;

const signerOf = (m: Made, name: string): KeyPairSigner => {
  const found = s.keys.get(m.file(name));
  if (found === undefined) {
    throw new Error(`no member ${name}`);
  }
  return found;
};

async function craft(m: Made, create: (transaction: Address, creator: Address) => Instruction): Promise<bigint> {
  const creator = signerOf(m, "a");
  const index = (await readMultisig(s.chain, m.address)).transactionIndex + 1n;
  const transaction = await transactionPda(m.address, index);
  await sendAs(creator, [
    create(transaction, creator.address),
    proposalCreate({ multisig: m.address, proposal: await proposalPda(m.address, index), creator: creator.address, index }),
  ]);
  return index;
}

const craftVault = (m: Made, instructions: Instruction[]) =>
  craft(m, (transaction, creator) =>
    vaultTransactionCreate({ multisig: m.address, transaction, creator, vaultIndex: 0, message: compileVaultMessage(m.vault, instructions) }),
  );

const craftConfig = (m: Made, actions: ConfigAction[]) => craft(m, (transaction, creator) => configTransactionCreate({ multisig: m.address, transaction, creator, actions }));

async function approveDirectly(m: Made, index: bigint, names: string[]): Promise<void> {
  for (const name of names) {
    const member = signerOf(m, name);
    await sendAs(member, [proposalApprove({ multisig: m.address, proposal: await proposalPda(m.address, index), member: member.address })]);
  }
}

async function upgradeable(vault: Address): Promise<Address> {
  const program = await randomAddress();
  s.set(await programDataOf(program), LOADER, header(3, [new Uint8Array(8), new Uint8Array([1]), bytesOf(vault), new Uint8Array(16)]));
  return program;
}

const bufferBytes = (authority: Address, code: Uint8Array) => header(1, [new Uint8Array([1]), bytesOf(authority), code]);

async function bufferHeldBy(authority: Address, code: Uint8Array): Promise<Address> {
  const at = await randomAddress();
  s.set(at, LOADER, bufferBytes(authority, code));
  return at;
}

const proposalOf = async (m: Made, index: bigint) => (await s.cli("show", "--multisig", m.address, "--index", index.toString())).json()["proposals"][0];

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

    const hashes = [];
    for (const member of ["a", "b"]) {
      const approved = await s.cli("approve", "--multisig", m.address, "--index", "1", "--keypair", m.file(member), "--yes");
      expect(approved.code).toBe(EXIT_OK);
      hashes.push(approved.json()["buffer_hash"]);
    }
    expect(hashes).toEqual([sha256(next), sha256(next)]);
    const before = s.account(buffer);
    expect(before.exists).toBe(true);
    const bufferLamports = before.exists ? before.lamports : 0n;
    const run = ["execute", "--multisig", m.address, "--index", "1", "--keypair", m.file("c"), "--expect-buffer-hash", sha256(next)];
    const preview = await s.cli(...run);
    expect(preview.json()).toMatchObject({ sent: false, simulation: "ok", buffer_hash: sha256(next) });
    const executed = await s.cli(...run, "--yes");
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
    expect(out).toMatchObject({ sent: true, index: "1", command });
    expect(out["summary"]).toEqual([
      `Proposes vault transaction 1 on multisig ${m.address}; it runs once 2 members approve`,
      `Intent engine RaisePause {"flags":${PAUSE_FILL}}, signed by ${m.vault}`,
    ]);
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

  it("the summary names set mint cap and set caps required", async () => {
    const m = await multisig("caps", 2);
    const admin = createNoopSigner(m.vault);
    const mint = await randomAddress();
    const cap = await buildSetMintCap({ admin, mint, maxPerOrder: 1_000n, windowCap: 5_000n, windowSecs: 3_600, totalLimit: 9_000n });
    const required = await buildSetCapsRequired({ admin, required: true });
    s.printed = printed(m.vault, [cap, required], ["Sets a mint cap and requires caps"]);
    const command = ["intent-engine", "set-mint-cap", "--authority", m.vault];
    const proposed = await s.cli("propose-admin", "--multisig", m.address, "--keypair", m.file("a"), "--yes", "--", ...command);
    expect([proposed.code, proposed.err]).toEqual([EXIT_OK, ""]);
    const lines = [
      `Intent engine SetMintCap {"maxPerOrder":"1000","windowCap":"5000","windowSecs":3600,"totalLimit":"9000"}, signed by ${m.vault}`,
      `Intent engine SetCapsRequired {"required":true}, signed by ${m.vault}`,
    ];
    expect(proposed.json()["summary"]).toEqual([`Proposes vault transaction 1 on multisig ${m.address}; it runs once 2 members approve`, ...lines]);
    const index = BigInt(proposed.json()["index"] as string);
    expect((await proposalOf(m, index))["summary"]).toEqual(lines);
    const capAccount = await findMintCapAddress(mint);
    expect(cap.accounts.map((meta) => meta.address)).toContain(capAccount);
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

  it("approve refuses an upgrade whose buffer the vault does not control", async () => {
    const m = await multisig("rogue-buffer", 2);
    const rogue = signerOf(m, "a").address;
    const program = await upgradeable(m.vault);
    const code = Uint8Array.from([9, 8, 7, 6, 0, 0]);
    const buffer = await bufferHeldBy(rogue, code);
    const spill = await randomAddress();
    const index = await craftVault(m, [await upgradeInstruction({ program, buffer, spill, authority: m.vault })]);

    const problem = `buffer ${buffer} is controlled by ${rogue}, not the vault ${m.vault}, so its code can change after approval`;
    const upgrade = `Upgrades program ${program} to the code in buffer ${buffer}, signed by ${m.vault}; the buffer's rent goes to ${spill}`;
    const shown = await proposalOf(m, index);
    expect(shown).toMatchObject({ kind: "vault", status: "active", problems: [problem], buffers: [{ buffer, authority: rogue, hash: sha256(code) }] });
    expect(shown["summary"]).toEqual([`${upgrade}; the buffer hashes to ${sha256(code)} and is controlled by ${rogue}`]);

    for (const name of ["b", "c"]) {
      const refused = await s.cli("approve", "--multisig", m.address, "--index", index.toString(), "--keypair", m.file(name), "--yes");
      expect([refused.code, refused.json()["refused"]]).toEqual([EXIT_REFUSED, true]);
      expect(refused.json()["error"]).toBe(`refusing to sign proposal ${index}: ${problem}; inspect it in the Squads app at ${SQUADS_SITE} and do not approve it blindly`);
      expect(refused.json()["proposal"]["summary"]).toEqual(shown["summary"]);
      expect(refused.json()["proposal"]["instructions"][0]["accounts"][6]).toEqual({ address: m.vault, signer: true, writable: true });
    }
    const gone = await randomAddress();
    const missing = await craftVault(m, [await upgradeInstruction({ program, buffer: gone, spill, authority: m.vault })]);
    const absent = await s.cli("approve", "--multisig", m.address, "--index", missing.toString(), "--keypair", m.file("b"), "--yes");
    expect(absent.json()["error"]).toContain(`buffer ${gone} is missing or not a program buffer`);
    expect((await proposalOf(m, index))["approved"]).toEqual([]);
    expect((await proposalOf(m, missing))["approved"]).toEqual([]);
  });

  it("execute refuses when the buffer hash changed since approval", async () => {
    const m = await multisig("swapped", 2);
    const program = await upgradeable(m.vault);
    const approvedCode = Uint8Array.from([1, 2, 3, 4, 0, 0, 0]);
    const swappedCode = Uint8Array.from([6, 6, 6, 6, 0, 0, 0]);
    const buffer = await bufferHeldBy(m.vault, approvedCode);
    const spill = await randomAddress();
    const proposed = await s.cli("propose-upgrade", "--multisig", m.address, "--program", program, "--buffer", buffer, "--spill", spill, "--keypair", m.file("a"), "--yes");
    expect(proposed.code).toBe(EXIT_OK);
    expect(proposed.json()["summary"][1]).toBe(
      `Upgrades program ${program} to the code in buffer ${buffer}, signed by ${m.vault}; the buffer's rent goes to ${spill}; the buffer hashes to ${sha256(approvedCode)} and is controlled by ${m.vault}`,
    );
    const approvals = [];
    for (const name of ["a", "b"]) {
      const approved = await s.cli("approve", "--multisig", m.address, "--index", "1", "--keypair", m.file(name), "--yes");
      expect(approved.code).toBe(EXIT_OK);
      approvals.push(approved.json());
    }
    expect(approvals.map((a) => a["buffer_hash"])).toEqual([sha256(approvedCode), sha256(approvedCode)]);
    expect(approvals[0]?.["proposal"]["buffers"]).toEqual([{ buffer, authority: m.vault, hash: sha256(approvedCode) }]);

    const run = ["execute", "--multisig", m.address, "--index", "1", "--keypair", m.file("c")];
    const unpinned = await s.cli(...run, "--yes");
    expect(unpinned.json()["error"]).toBe(
      "proposal 1 upgrades a program; pass --expect-buffer-hash with the buffer hash approve printed, so the code that runs is the code that was approved",
    );
    const malformed = await s.cli(...run, "--expect-buffer-hash", "abc", "--yes");
    expect(malformed.code).toBe(EXIT_USAGE);

    s.set(buffer, LOADER, bufferBytes(m.vault, swappedCode));
    const swapped = await s.cli(...run, "--expect-buffer-hash", sha256(approvedCode), "--yes");
    expect([swapped.code, swapped.json()["error"]]).toEqual([
      EXIT_REFUSED,
      `buffer ${buffer} hashes to ${sha256(swappedCode)}, not the approved ${sha256(approvedCode)}; its code changed since approval, so do not execute it`,
    ]);

    s.set(buffer, LOADER, bufferBytes(m.vault, approvedCode));
    const sends: string[] = [];
    const racing: Chain = {
      ...s.chain,
      blockhash: async () => {
        s.set(buffer, LOADER, bufferBytes(m.vault, swappedCode));
        return s.chain.blockhash();
      },
      send: async (tx) => {
        sends.push("sent");
        return s.chain.send(tx);
      },
    };
    const raced = await main([...run, "--expect-buffer-hash", sha256(approvedCode), "--yes"], { ...s.deps, chain: () => racing });
    expect(raced.code).toBe(EXIT_REFUSED);
    expect(JSON.parse(raced.err)["error"]).toContain(`hashes to ${sha256(swappedCode)}, not the approved ${sha256(approvedCode)}`);
    expect(sends).toEqual([]);
    expect((await proposalOf(m, 1n))["status"]).toBe("approved");
    expect(s.account(buffer).exists).toBe(true);
  });

  it("approve refuses a config transaction without allow config", async () => {
    const m = await multisig("config", 2);
    const intruder = await randomAddress();
    const actions: ConfigAction[] = [
      { __kind: "AddMember", newMember: { key: intruder, permissions: { mask: 7 } } },
      { __kind: "ChangeThreshold", newThreshold: 1 },
      { __kind: "SetTimeLock", newTimeLock: 0 },
    ];
    const index = await craftConfig(m, actions);
    const members = (await readMultisig(s.chain, m.address)).members.map((k) => k.key);
    const summary = [
      `Config transaction: changes multisig ${m.address} itself`,
      `Adds member ${intruder} with initiate, vote, execute`,
      "Changes the threshold from 2 to 1",
      "Changes the time lock from 0 to 0 seconds",
      `After it runs: members ${[...members, intruder].join(", ")}; threshold 1 of 4; time lock 0 seconds`,
    ];
    const shown = await proposalOf(m, index);
    expect(shown).toMatchObject({ kind: "config", creator: m.members[0]?.address, summary });

    const on = ["--multisig", m.address, "--index", index.toString()];
    const refused = await s.cli("approve", ...on, "--keypair", m.file("b"), "--yes");
    expect([refused.code, refused.json()["error"]]).toEqual([
      EXIT_REFUSED,
      `proposal ${index} is a config transaction that changes the multisig itself; read the changes in the summary, inspect it in the Squads app at ${SQUADS_SITE} and do not approve it blindly, and pass --allow-config only if every change is expected`,
    ]);
    expect(refused.json()["proposal"]).toMatchObject({ kind: "config", summary });
    expect((await proposalOf(m, index))["approved"]).toEqual([]);

    for (const name of ["a", "b"]) {
      const allowed = await s.cli("approve", ...on, "--allow-config", "--keypair", m.file(name), "--yes");
      expect(allowed.code).toBe(EXIT_OK);
      expect(allowed.json()["summary"].slice(2)).toEqual(summary);
    }
    const blind = await s.cli("execute", ...on, "--keypair", m.file("c"), "--yes");
    expect(blind.json()["error"]).toContain("is a config transaction that changes the multisig itself");
    const executed = await s.cli("execute", ...on, "--allow-config", "--keypair", m.file("c"), "--yes");
    expect([executed.code, executed.err]).toEqual([EXIT_OK, ""]);
    const after = await readMultisig(s.chain, m.address);
    expect([after.threshold, after.members.map((k) => k.key)]).toEqual([1, expect.arrayContaining([...members, intruder])]);
  });

  it("execute refuses a message with a signer other than the vault", async () => {
    const m = await multisig("lend", 2);
    const executor = signerOf(m, "c");
    const thief = await randomAddress();
    const drain: Instruction = {
      programAddress: SYSTEM_PROGRAM,
      accounts: [
        { address: executor.address, role: AccountRole.WRITABLE_SIGNER },
        { address: thief, role: AccountRole.WRITABLE },
      ],
      data: Uint8Array.from([2, 0, 0, 0, ...getU64Encoder().encode(SOL)]),
    };
    const index = await craftVault(m, [drain]);
    const problem = `it asks ${executor.address} to sign, but only the vault ${m.vault} and the transaction's ephemeral signers may; executing it would lend ${executor.address}'s signature to it`;
    const shown = await proposalOf(m, index);
    expect(shown).toMatchObject({ kind: "vault", problems: [problem] });
    expect(shown["summary"]).toEqual([`Runs program ${SYSTEM_PROGRAM} with 2 accounts and 12 bytes of data, signed by ${executor.address}`]);
    expect(shown["instructions"][0]["accounts"]).toEqual([
      { address: executor.address, signer: true, writable: true },
      { address: thief, signer: false, writable: true },
    ]);
    const on = ["--multisig", m.address, "--index", index.toString(), "--yes"];
    expect((await s.cli("approve", ...on, "--keypair", m.file("a"))).json()["error"]).toContain(problem);

    await approveDirectly(m, index, ["a", "b"]);
    expect((await proposalOf(m, index))["status"]).toBe("approved");
    const balance = () => {
      const held = s.account(executor.address);
      return held.exists ? held.lamports : 0n;
    };
    const before = balance();
    const refused = await s.cli("execute", ...on, "--keypair", m.file("c"));
    expect([refused.code, refused.json()["error"]]).toEqual([
      EXIT_REFUSED,
      `refusing to sign proposal ${index}: ${problem}; inspect it in the Squads app at ${SQUADS_SITE} and do not approve it blindly`,
    ]);
    await expect(executeInstruction(s.chain, { multisig: m.address, index, member: executor.address })).rejects.toThrow(
      `the vault transaction asks ${executor.address} to sign, but only the vault and its ephemeral signers may`,
    );
    expect(s.account(thief).exists).toBe(false);
    expect(balance()).toBe(before);
    expect((await proposalOf(m, index))["status"]).toBe("approved");
  });

  it("a lookup table proposal is reported as undecodable", async () => {
    const m = await multisig("lookup", 2);
    s.printed = printed(m.vault, [await buildRaisePause({ authority: createNoopSigner(m.vault), flags: PAUSE_FILL })], []);
    expect((await s.cli("propose-admin", "--multisig", m.address, "--keypair", m.file("a"), "--yes", "--", "intent-engine", "raise-pause")).code).toBe(EXIT_OK);
    const stored = await readVaultTransaction(s.chain, m.address, 1n);
    const table = await randomAddress();
    s.set(
      await transactionPda(m.address, 1n),
      SQUADS_PROGRAM,
      encodeAccount("VaultTransaction", vaultTransactionCodec, {
        ...stored!,
        message: {
          numSigners: 1,
          numWritableSigners: 1,
          numWritableNonSigners: 0,
          accountKeys: [m.vault, SYSTEM_PROGRAM],
          instructions: [{ programIdIndex: 1, accountIndexes: Uint8Array.from([0, 2]), data: Uint8Array.from([2, 0, 0, 0, ...getU64Encoder().encode(SOL)]) }],
          addressTableLookups: [{ accountKey: table, writableIndexes: Uint8Array.from([0]), readonlyIndexes: new Uint8Array() }],
        },
      }),
    );
    const all = await s.cli("show", "--multisig", m.address);
    expect(all.code).toBe(EXIT_OK);
    const problem = "it uses address lookup tables, so this tool cannot show every account it touches";
    expect(all.json()["proposals"][0]).toMatchObject({
      index: "1",
      kind: "vault",
      summary: [`Undecodable: the message loads accounts from address lookup tables ${table}, which this tool does not read, so it cannot show every account`],
      instructions: [],
      problems: [problem],
    });
    const on = ["--multisig", m.address, "--index", "1", "--yes"];
    const refused = await s.cli("approve", ...on, "--keypair", m.file("b"));
    expect([refused.code, refused.json()["error"]]).toEqual([
      EXIT_REFUSED,
      `refusing to sign proposal 1: ${problem}; inspect it in the Squads app at ${SQUADS_SITE} and do not approve it blindly`,
    ]);
    await approveDirectly(m, 1n, ["a", "b"]);
    expect((await s.cli("execute", ...on, "--keypair", m.file("c"))).json()["error"]).toContain(problem);
    expect(() => messageInstructions({ ...stored!.message, accountKeys: [m.vault], instructions: [{ programIdIndex: 3, accountIndexes: new Uint8Array(), data: new Uint8Array() }] })).toThrow(
      "beyond the message's 1 keys",
    );
  });

  it("reject records a rejection", async () => {
    const m = await multisig("reject", 2);
    s.printed = printed(m.vault, [await buildRaisePause({ authority: createNoopSigner(m.vault), flags: PAUSE_FILL })], []);
    expect((await s.cli("propose-admin", "--multisig", m.address, "--keypair", m.file("a"), "--yes", "--", "intent-engine", "raise-pause")).code).toBe(EXIT_OK);
    const on = ["--multisig", m.address, "--index", "1"];
    const preview = await s.cli("reject", ...on, "--keypair", m.file("b"));
    expect(preview.json()).toMatchObject({ sent: false, simulation: "ok", rejections: 1, cutoff: 2 });
    const first = await s.cli("reject", ...on, "--keypair", m.file("b"), "--yes");
    expect([first.code, first.err]).toEqual([EXIT_OK, ""]);
    expect(first.json()["summary"]).toEqual([
      `Rejects proposal 1 on multisig ${m.address} as ${m.members[1]?.address}`,
      "This is rejection 1 of 2",
      `Intent engine RaisePause {"flags":${PAUSE_FILL}}, signed by ${m.vault}`,
    ]);
    expect(await proposalOf(m, 1n)).toMatchObject({ status: "active", rejected: [m.members[1]?.address] });
    expect((await s.cli("reject", ...on, "--keypair", m.file("b"), "--yes")).json()["error"]).toBe(`${m.members[1]?.address} already rejected proposal 1`);
    const second = await s.cli("reject", ...on, "--keypair", m.file("c"), "--yes");
    expect(second.json()["summary"][1]).toBe("This is rejection 2 of 2; the proposal is then rejected and can never execute");
    const rejected = await proposalOf(m, 1n);
    expect(rejected["status"]).toBe("rejected");
    expect([...rejected["rejected"]].sort()).toEqual([m.members[1]?.address, m.members[2]?.address].sort());
    expect((await s.cli("approve", ...on, "--keypair", m.file("a"), "--yes")).json()["error"]).toBe("proposal 1 is rejected, so it takes no more approvals");
    expect((await s.cli("execute", ...on, "--keypair", m.file("a"), "--yes")).json()["error"]).toBe("proposal 1 is rejected, so it cannot execute");

    const locked = await multisig("cancel", 2, 3600);
    s.printed = printed(locked.vault, [await buildRaisePause({ authority: createNoopSigner(locked.vault), flags: PAUSE_FILL })], []);
    const lockedOn = ["--multisig", locked.address, "--index", "1", "--yes"];
    expect((await s.cli("propose-admin", "--multisig", locked.address, "--keypair", locked.file("a"), "--yes", "--", "intent-engine", "raise-pause")).code).toBe(EXIT_OK);
    for (const name of ["a", "b"]) {
      expect((await s.cli("approve", ...lockedOn, "--keypair", locked.file(name))).code).toBe(EXIT_OK);
    }
    for (const name of ["b", "c"]) {
      const cancelled = await s.cli("reject", ...lockedOn, "--keypair", locked.file(name));
      expect([cancelled.code, cancelled.err]).toEqual([EXIT_OK, ""]);
    }
    const revoked = await proposalOf(locked, 1n);
    expect(revoked["status"]).toBe("cancelled");
    expect([...revoked["cancelled"]].sort()).toEqual([locked.members[1]?.address, locked.members[2]?.address].sort());
    expect((await s.cli("reject", ...lockedOn, "--keypair", locked.file("a"))).json()["error"]).toBe("proposal 1 is cancelled, so there is nothing to reject");
  });

  it("every loader instruction is described exactly, with its signers checked", async () => {
    const vault = await randomAddress();
    const other = await randomAddress();
    const program = await upgradeable(vault);
    const programData = await programDataOf(program);
    const code = Uint8Array.from([5, 5, 5]);
    const buffer = await bufferHeldBy(vault, code);
    const spill = await randomAddress();
    const upgrade = await upgradeInstruction({ program, buffer, spill, authority: vault });
    const role = (signer: boolean) => (signer ? AccountRole.READONLY_SIGNER : AccountRole.READONLY);
    const loader = (tag: number, accounts: [Address, boolean][], extra: number[] = []): Instruction => ({
      programAddress: LOADER,
      accounts: accounts.map(([at, signer], i) => ({ address: at, role: i === 0 ? AccountRole.WRITABLE : role(signer) })),
      data: Uint8Array.from([tag, 0, 0, 0, ...extra]),
    });
    const { decoded, buffers } = await describeInstructions(s.chain, [
      { ...upgrade, accounts: (upgrade.accounts ?? []).map((a) => (a.address === vault ? { ...a, role: AccountRole.READONLY } : a)) },
      { ...upgrade, data: Uint8Array.from([3, 0, 0, 0, 9, 9]) },
      loader(4, [[programData, false], [vault, true]]),
      loader(4, [[buffer, false], [vault, true], [other, false]]),
      loader(4, [[programData, false], [vault, true], [other, false]]),
      loader(7, [[programData, false], [vault, true], [other, false]]),
      loader(7, [[buffer, false], [vault, true], [other, true]]),
      loader(4, [[buffer, false], [vault, false]]),
      loader(5, [[buffer, false], [spill, false], [vault, true]]),
    ]);
    const hashed = `the buffer hashes to ${sha256(code)} and is controlled by ${vault}`;
    expect(decoded.map((d) => d.summary)).toEqual([
      `Upgrades program ${program} to the code in buffer ${buffer}, naming ${vault} as authority without its signature, so the loader refuses it; the buffer's rent goes to ${spill}; ${hashed}`,
      `Upgrades program ${program} to the code in buffer ${buffer}, signed by ${vault}; the buffer's rent goes to ${spill}; the instruction carries 2 more bytes of data, which the loader ignores; ${hashed}`,
      `Makes the program whose data is ${programData} immutable: removes the upgrade authority ${vault} for good`,
      `Hands the authority of buffer ${buffer} from ${vault} to ${other}`,
      `Hands the upgrade authority of the program whose data is ${programData} from ${vault} to ${other}`,
      `Hands the upgrade authority of the program whose data is ${programData} from ${vault} to ${other}; both sign; ${other} does not sign, so the loader refuses it`,
      `Hands the authority of buffer ${buffer} from ${vault} to ${other}; both sign`,
      `Removes the authority of buffer ${buffer}, which the loader refuses for a buffer; ${vault} does not sign, so the loader refuses it`,
      `Loader Close with 3 accounts and 4 bytes of data, signed by ${vault}`,
    ]);
    expect(buffers).toEqual([
      { buffer, authority: vault, hash: sha256(code) },
      { buffer, authority: vault, hash: sha256(code) },
    ]);
  });

  it("keypair errors never echo file contents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "multisig-keys-"));
    const cases: [string, string][] = [
      ["broken.json", "[201,202,203,hunter2secret"],
      ["short.json", JSON.stringify([201, 202, 203])],
      ["wide.json", JSON.stringify(Array.from({ length: 64 }, () => 777))],
      ["mismatched.json", JSON.stringify(Array.from({ length: 64 }, (_, i) => 200 + (i % 50)))],
    ];
    for (const [name, text] of cases) {
      const path = join(dir, name);
      writeFileSync(path, text);
      const error = await readKeypair(path).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toBe(`the keypair file ${path} is not a keypair: it holds no JSON array of 64 bytes that form a key pair`);
      const result = await main(["approve", "--multisig", await randomAddress(), "--index", "1", "--keypair", path], { ...s.deps, keypair: readKeypair });
      expect(result.code).toBe(EXIT_REFUSED);
      expect(JSON.parse(result.err)["error"]).toBe(message);
      for (const leaked of ["201", "202", "777", "hunter2", "secret"]) {
        expect(message.replaceAll(path, "")).not.toContain(leaked);
        expect(result.err.replaceAll(path, "")).not.toContain(leaked);
      }
    }
    const absent = join(dir, "absent.json");
    await expect(readKeypair(absent)).rejects.toThrow(`cannot read the keypair file ${absent}: it is missing or unreadable`);
  });

  it("rpc urls keep their query for requests and print only scheme, host and port", async () => {
    const m = await multisig("url", 2);
    s.printed = printed(m.vault, [await buildRaisePause({ authority: createNoopSigner(m.vault), flags: PAUSE_FILL })], []);
    const asked: string[] = [];
    const url = "https://rpc.example.com:8443/v2/path-token?api-key=querytoken";
    const result = await main(["propose-admin", "--multisig", m.address, "--keypair", m.file("a"), "--url", url, "--", "intent-engine", "raise-pause"], {
      ...s.deps,
      chain: (given) => {
        asked.push(given);
        return s.chain;
      },
    });
    expect(result.code).toBe(EXIT_OK);
    expect(asked).toEqual([url]);
    expect(JSON.parse(result.out)["cluster"]).toBe("https://rpc.example.com:8443");
    expect(result.out).not.toContain("querytoken");
    expect(result.out).not.toContain("path-token");
    const bad = await main(["show", "--multisig", m.address, "--url", "wss://rpc.example.com/?api-key=querytoken"], s.deps);
    expect([bad.code, bad.err.includes("querytoken")]).toEqual([EXIT_USAGE, false]);
  });
});
