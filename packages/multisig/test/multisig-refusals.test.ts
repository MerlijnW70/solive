import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getU64Encoder,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
} from "@solana/kit";
import { buildRaisePause, PAUSE_FILL } from "@intent-engine/core/internal";
import { beforeAll, describe, expect, it } from "vitest";
import type { Chain } from "../src/chain.js";
import {
  type ConfigAction,
  encodeAccount,
  SQUADS_PROGRAM,
  SYSTEM_PROGRAM,
  transactionPda,
  vaultTransactionCodec,
} from "../src/layout.js";
import { EXIT_OK, EXIT_REFUSED, EXIT_USAGE, main } from "../src/main.js";
import {
  executeInstruction,
  LOADER,
  messageInstructions,
  readMultisig,
  readVaultTransaction,
  upgradeInstruction,
} from "../src/squads.js";
import { randomAddress, SOL } from "./svm.js";
import {
  approveDirectly,
  bufferBytes,
  bufferHeldBy,
  craftConfig,
  craftVault,
  multisig,
  openSvm,
  printed,
  proposalOf,
  s,
  sha256,
  signerOf,
  SQUADS_SITE,
  upgradeable,
} from "./multisig-world.js";

beforeAll(openSvm);

describe("multisig", () => {
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
});
