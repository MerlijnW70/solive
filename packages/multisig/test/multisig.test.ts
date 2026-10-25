import { address, createNoopSigner } from "@solana/kit";
import { buildProposeAdmin, buildRaisePause, buildSetCapsRequired, buildSetMintCap, findMintCapAddress, PAUSE_FILL } from "@intent-engine/core/internal";
import { beforeAll, describe, expect, it } from "vitest";
import { EXIT_OK, EXIT_REFUSED } from "../src/main.js";
import {
  ENGINE_PROGRAM,
  type InstructionView,
  instructionView,
  LOADER,
  messageInstructions,
  programDataOf,
  readVaultTransaction,
  SYSVAR_CLOCK,
  SYSVAR_RENT,
} from "../src/squads.js";
import { engineProgram, randomAddress, squadsProgram } from "./svm.js";
import {
  base64,
  bytesOf,
  header,
  multisig,
  openSvm,
  paidByVault,
  printed,
  printedView,
  proposalOf,
  s,
  sha256,
} from "./multisig-world.js";

beforeAll(openSvm);

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
});
