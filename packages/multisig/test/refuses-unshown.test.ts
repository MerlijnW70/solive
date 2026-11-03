import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountRole, type Address, address, createKeyPairSignerFromPrivateKeyBytes, createNoopSigner, generateKeyPairSigner, getAddressEncoder, type Instruction } from "@solana/kit";
import { buildRaisePause, PAUSE_FILL } from "@intent-engine/core/internal";
import { beforeAll, describe, expect, it } from "vitest";
import { keypairExposed, readKeypair } from "../src/keys.js";
import { proposalApprove, proposalCreate, proposalPda, proposalReject, transactionPda, vaultTransactionCreate, compileVaultMessage } from "../src/layout.js";
import { EXIT_OK, EXIT_REFUSED, EXIT_USAGE, main, PLAIN_HTTP } from "../src/main.js";
import { describeInstructions } from "../src/review.js";
import { ENGINE_PROGRAM, LOADER, programDataOf, PROPOSE_PROBLEMS, readMultisig } from "../src/squads.js";
import { approveDirectly, craftConfig, craftVault, type Made, multisig, openSvm, printed, proposalOf, s, sendAs, signerOf, upgradeable } from "./multisig-world.js";

beforeAll(openSvm);

const UNSHOWN = "which this tool does not decode, so approving it would sign for an effect the tool cannot show";

const loaderIx = (tag: number, accounts: [Address, AccountRole][]): Instruction => ({
  programAddress: LOADER,
  accounts: accounts.map(([address, role]) => ({ address, role })),
  data: Uint8Array.from([tag, 0, 0, 0]),
});

const raise = async (m: Made) => buildRaisePause({ authority: createNoopSigner(m.vault), flags: PAUSE_FILL });

function transfer(from: Address, to: Address, lamports: bigint): Instruction {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, lamports, true);
  return {
    programAddress: address("11111111111111111111111111111111"),
    accounts: [
      { address: from, role: AccountRole.WRITABLE_SIGNER },
      { address: to, role: AccountRole.WRITABLE },
    ],
    data,
  };
}

const indexOf = async (m: Made) => (await readMultisig(s.chain, m.address)).transactionIndex;

describe("the multisig tool refuses what it cannot show", () => {
  it("approve and execute refuse a vault-signed loader Migrate and an unknown loader tag", async () => {
    const m = await multisig("migrate", 2);
    const program = await upgradeable(m.vault);
    const programData = await programDataOf(program);
    const migrate = loaderIx(8, [
      [programData, AccountRole.WRITABLE],
      [program, AccountRole.WRITABLE],
      [m.vault, AccountRole.READONLY_SIGNER],
    ]);
    const unknown = loaderIx(42, [[programData, AccountRole.WRITABLE], [m.vault, AccountRole.READONLY_SIGNER]]);
    const migrateText = `instruction 1 is a loader Migrate, which moves the program whose data is ${programData} to loader v4, where this tool can no longer review, upgrade or hand over its authority`;
    const unknownText = "instruction 1 is loader instruction 42, which this tool does not know, so approving it would sign for an effect the tool cannot show";
    for (const [ix, text] of [
      [migrate, migrateText],
      [unknown, unknownText],
    ] as const) {
      const index = await craftVault(m, [ix]);
      const on = ["--multisig", m.address, "--index", index.toString()];
      expect((await proposalOf(m, index))["problems"]).toEqual([text]);
      const approved = await s.cli("approve", ...on, "--keypair", m.file("b"), "--yes");
      expect([approved.code, approved.json()["error"]]).toEqual([EXIT_REFUSED, expect.stringContaining(text)]);
      await approveDirectly(m, index, ["a", "b"]);
      const executed = await s.cli("execute", ...on, "--keypair", m.file("c"), "--yes");
      expect([executed.code, executed.json()["error"]]).toEqual([EXIT_REFUSED, expect.stringContaining(text)]);
      expect((await proposalOf(m, index))["status"]).toBe("approved");
    }
  });

  it("every loader instruction it does not decode carries a problem", async () => {
    const vault = (await generateKeyPairSigner()).address;
    const target = (await generateKeyPairSigner()).address;
    const named: [number, string][] = [
      [0, "InitializeBuffer"],
      [1, "Write"],
      [2, "DeployWithMaxDataLen"],
      [6, "ExtendProgram"],
      [9, "ExtendProgramChecked"],
    ];
    const { problems } = await describeInstructions(
      s.chain,
      [...named.map(([tag]) => loaderIx(tag, [[target, AccountRole.WRITABLE], [vault, AccountRole.READONLY_SIGNER]])), loaderIx(10, [[target, AccountRole.WRITABLE]])],
      vault,
    );
    expect(problems).toEqual([
      ...named.map(([, name], i) => `instruction ${i + 1} is a loader ${name}, ${UNSHOWN}`),
      "instruction 6 is loader instruction 10, which this tool does not know, so approving it would sign for an effect the tool cannot show",
    ]);
  });

  it("a key file other users can read is refused on unix, and a tilde path is expanded", async () => {
    const home = mkdtempSync(join(tmpdir(), "multisig-home-"));
    const seed = new Uint8Array(32).fill(11);
    const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
    const bytes = JSON.stringify([...seed, ...getAddressEncoder().encode(signer.address)]);
    const path = join(home, "member.json");
    writeFileSync(path, bytes, { mode: 0o600 });
    for (const mode of [0o640, 0o604, 0o620, 0o602]) {
      chmodSync(path, mode);
      await expect(readKeypair(path, "linux", home)).rejects.toThrow(keypairExposed(path));
      await expect(readKeypair("~/member.json", "linux", home)).rejects.toThrow(keypairExposed(path));
      expect((await readKeypair(path, "win32", home)).address).toBe(signer.address);
      const refused = await main(["approve", "--multisig", signer.address, "--index", "1", "--keypair", path], { ...s.deps, keypair: (given) => readKeypair(given, "linux", home) });
      expect([refused.code, JSON.parse(refused.err)["error"]]).toEqual([EXIT_REFUSED, keypairExposed(path)]);
    }
    chmodSync(path, 0o600);
    expect((await readKeypair(path, "linux", home)).address).toBe(signer.address);
    expect((await readKeypair("~/member.json", "linux", home)).address).toBe(signer.address);
    await expect(readKeypair("~/absent.json", "linux", home)).rejects.toThrow(`cannot read the keypair file ${join(home, "absent.json")}: it is missing or unreadable`);
  });

  it("propose shows a review problem and refuses it without an override", async () => {
    const m = await multisig("propose-problem", 2);
    const undecodable: Instruction = {
      programAddress: ENGINE_PROGRAM,
      accounts: [{ address: m.vault, role: AccountRole.WRITABLE_SIGNER }],
      data: Uint8Array.from([255, 255, 255, 255, 255, 255, 255, 255, 1, 2, 3, 4]),
    };
    const problem = "it carries an intent engine instruction whose 12 bytes this version cannot decode, so approving it would sign for an effect the tool cannot show";
    s.printed = printed(m.vault, [undecodable], []);
    const args = ["propose-admin", "--multisig", m.address, "--keypair", m.file("a")];
    const command = ["--", "intent-engine", "raise-pause", "--authority", m.vault];
    for (const yes of [[], ["--yes"]]) {
      const refused = await s.cli(...args, ...yes, ...command);
      expect([refused.code, refused.json()["error"], refused.json()["proposal"]["problems"]]).toEqual([EXIT_REFUSED, `refusing to propose: ${problem}; ${PROPOSE_PROBLEMS}`, [problem]]);
    }
    expect(await indexOf(m)).toBe(0n);
    const proposed = await s.cli(...args, "--allow-review-problems", "--yes", ...command);
    expect([proposed.code, proposed.json()["sent"], proposed.json()["problems"], proposed.json()["summary"][0]]).toEqual([EXIT_OK, true, [problem], `Warning: ${problem}`]);
    expect((await proposalOf(m, 1n))["problems"]).toEqual([problem]);
    expect((await s.cli("approve", "--multisig", m.address, "--index", "1", "--keypair", m.file("b"))).code).toBe(EXIT_REFUSED);
    s.printed = printed(m.vault, [await raise(m)], []);
    const clean = await s.cli(...args, "--allow-review-problems", "--yes", ...command);
    expect([clean.code, clean.json()["summary"][0], clean.json()["problems"]]).toEqual([EXIT_OK, `Proposes vault transaction 2 on multisig ${m.address}; it runs once 2 members approve`, undefined]);
  });

  it("flags a command does not use are refused before anything is read", async () => {
    const m = await multisig("flags-unused", 2);
    const member = m.members.map((k) => k.address).join(",");
    const reads: Address[] = [];
    const counted = (...argv: string[]) =>
      main(argv, {
        ...s.deps,
        chain: () => ({ ...s.chain, account: async (at) => (reads.push(at), s.chain.account(at)) }),
      });
    const cases: [string[], string][] = [
      [["create", "--members", member, "--threshold", "2", "--seconds", "3600", "--keypair", m.file("a")], "create takes no --seconds"],
      [["propose-time-lock", "--multisig", m.address, "--time-lock", "60", "--keypair", m.file("a")], "propose-time-lock takes no --time-lock"],
      [["approve", "--multisig", m.address, "--index", "1", "--expect-buffer-hash", "a".repeat(64), "--keypair", m.file("a")], "approve takes no --expect-buffer-hash"],
      [["reject", "--multisig", m.address, "--index", "1", "--allow-config", "--allow-engine-close", "--keypair", m.file("a")], "reject takes no --allow-config or --allow-engine-close"],
      [["show", "--multisig", m.address, "--keypair", m.file("a"), "--yes", "--allow-review-problems"], "show takes no --keypair, --yes or --allow-review-problems"],
      [["vault", "--multisig", m.address, "--index", "1"], "vault takes no --index"],
      [["propose-upgrade", "--multisig", m.address, "--buffer", m.vault, "--spill", m.vault, "--new-authority", m.vault, "--keypair", m.file("a")], "propose-upgrade takes no --new-authority"],
    ];
    for (const [argv, error] of cases) {
      const refused = await counted(...argv);
      expect([refused.code, JSON.parse(refused.err)["error"], reads]).toEqual([EXIT_USAGE, error, []]);
    }
    const index = await craftConfig(m, [{ __kind: "SetTimeLock", newTimeLock: 0 }]);
    await approveDirectly(m, index, ["a", "b"]);
    const on = ["--multisig", m.address, "--index", index.toString(), "--allow-config", "--keypair", m.file("c")];
    const hashed = await s.cli("execute", ...on, "--expect-buffer-hash", "a".repeat(64), "--yes");
    expect([hashed.code, hashed.json()["error"]]).toEqual([EXIT_REFUSED, `proposal ${index} is a config transaction, which upgrades nothing, so --expect-buffer-hash does not apply`]);
    expect((await proposalOf(m, index))["status"]).toBe("approved");
    expect((await s.cli("execute", ...on, "--yes")).code).toBe(EXIT_OK);
  });

  it("a stale proposal gets the stale refusal, and a draft the draft refusal", async () => {
    const m = await multisig("stale", 2);
    const pending = await craftVault(m, [await raise(m)]);
    s.fund(m.vault);
    const approvedVault = await craftVault(m, [transfer(m.vault, (await generateKeyPairSigner()).address, 1_000_000n)]);
    await approveDirectly(m, approvedVault, ["a", "b"]);
    const oldConfig = await craftConfig(m, [{ __kind: "SetTimeLock", newTimeLock: 0 }]);
    await approveDirectly(m, oldConfig, ["a", "b"]);
    const change = await craftConfig(m, [{ __kind: "ChangeThreshold", newThreshold: 2 }]);
    await approveDirectly(m, change, ["a", "b"]);
    expect((await s.cli("execute", "--multisig", m.address, "--index", change.toString(), "--allow-config", "--keypair", m.file("a"), "--yes")).code).toBe(EXIT_OK);
    const multisigNow = await readMultisig(s.chain, m.address);
    expect(multisigNow.staleTransactionIndex).toBe(change);
    const stale = (index: bigint, action: string) =>
      `proposal ${index} is stale: a change to the multisig's members, threshold or time lock executed after it was made, which marks every proposal up to ${change} stale, so Squads refuses to ${action} it; propose it again`;
    const on = (index: bigint) => ["--multisig", m.address, "--index", index.toString(), "--keypair", m.file("c")];
    for (const action of ["approve", "reject", "execute"]) {
      const refused = await s.cli(action, ...on(pending));
      expect([refused.code, refused.json()["error"]]).toEqual([EXIT_REFUSED, stale(pending, action)]);
    }
    const staleConfig = await s.cli("execute", ...on(oldConfig), "--allow-config");
    expect([staleConfig.code, staleConfig.json()["error"]]).toEqual([EXIT_REFUSED, stale(oldConfig, "execute")]);
    const proposal = await proposalPda(m.address, pending);
    const voter = signerOf(m, "c");
    await expect(sendAs(voter, [proposalApprove({ multisig: m.address, proposal, member: voter.address })])).rejects.toThrow();
    await expect(sendAs(voter, [proposalReject({ multisig: m.address, proposal, member: voter.address })])).rejects.toThrow();
    const cancel = await s.cli("reject", ...on(approvedVault));
    expect([cancel.code, cancel.json()["simulation"]]).toEqual([EXIT_OK, "ok"]);
    const staleExecute = await s.cli("execute", ...on(approvedVault));
    expect([staleExecute.code, staleExecute.json()["simulation"]]).toEqual([EXIT_OK, "ok"]);

    const creator = signerOf(m, "a");
    const draft = (await readMultisig(s.chain, m.address)).transactionIndex + 1n;
    const create = proposalCreate({ multisig: m.address, proposal: await proposalPda(m.address, draft), creator: creator.address, index: draft });
    const data = Uint8Array.from(create.data ?? []);
    data[data.length - 1] = 1;
    await sendAs(creator, [
      vaultTransactionCreate({ multisig: m.address, transaction: await transactionPda(m.address, draft), creator: creator.address, vaultIndex: 0, message: compileVaultMessage(m.vault, [await raise(m)]) }),
      { ...create, data },
    ]);
    expect((await proposalOf(m, draft))["status"]).toBe("draft");
    for (const action of ["approve", "reject", "execute"]) {
      const refused = await s.cli(action, ...on(draft));
      expect([refused.code, refused.json()["error"]]).toEqual([
        EXIT_REFUSED,
        `proposal ${draft} is a draft that its creator never activated, so it cannot ${action} until it is activated; inspect it in the Squads app at https://app.squads.so and do not approve it blindly before activating it`,
      ]);
    }
  });

  it("propose-admin checks the command and the member before it runs the command", async () => {
    const m = await multisig("admin-first", 2);
    s.printed = printed(m.vault, [await raise(m)], []);
    const stranger = await s.member("admin-first-stranger.json");
    const runs = s.runs.length;
    const args = ["propose-admin", "--multisig", m.address, "--yes"];
    const other = stranger.address;
    const cases: [string[], number, string][] = [
      [
        [...args, "--keypair", m.file("a"), "--", "intent-engine", "raise-pause", "--yes"],
        EXIT_USAGE,
        `propose-admin refuses a command with --yes, which would sign and send it on its own; give it --authority ${m.vault} instead, so it prints the transaction unsigned`,
      ],
      [
        [...args, "--keypair", m.file("a"), "--", "intent-engine", "raise-pause", `--authority=${other}`],
        EXIT_USAGE,
        `the command names --authority ${other}, but the proposal signs as the vault ${m.vault}; give it --authority ${m.vault}`,
      ],
      [[...args, "--keypair", "admin-first-stranger.json", "--", "intent-engine", "raise-pause", "--authority", m.vault], EXIT_REFUSED, `${other} is not a member of multisig ${m.address}, so it cannot propose`],
    ];
    for (const [argv, code, error] of cases) {
      const refused = await s.cli(...argv);
      expect([refused.code, refused.json()["error"]]).toEqual([code, error]);
    }
    expect(s.runs.length).toBe(runs);
    s.printed = JSON.stringify({ sent: false, summary: ["preview"] });
    const preview = await s.cli(...args, "--keypair", m.file("a"), "--", "intent-engine", "raise-pause");
    expect([preview.code, preview.json()["error"]]).toEqual([EXIT_REFUSED, "the command printed no unsigned transaction; run an intent engine admin command with --authority <vault>"]);
    expect(await indexOf(m)).toBe(0n);
  });

  it("plain http is refused for a node other than this machine", async () => {
    const asked: string[] = [];
    const deps = {
      ...s.deps,
      chain: (url: string) => {
        asked.push(url);
        return s.chain;
      },
    };
    const m = await multisig("plain-http", 2);
    for (const url of ["http://rpc.example.com", "http://api.devnet.solana.com:80/", "http://10.0.0.5:8899", "http://127.0.0.1.example.com:8899"]) {
      const refused = await main(["show", "--multisig", m.address, "--url", url], deps);
      expect([refused.code, JSON.parse(refused.err)["error"]]).toEqual([EXIT_USAGE, PLAIN_HTTP]);
    }
    expect(asked).toEqual([]);
    for (const url of ["localhost", "http://127.0.0.1:8899", "http://localhost:8899", "http://[::1]:8899", "https://rpc.example.com"]) {
      expect((await main(["show", "--multisig", m.address, "--url", url], deps)).code).toBe(EXIT_OK);
    }
    expect(asked).toEqual(["http://127.0.0.1:8899", "http://127.0.0.1:8899", "http://localhost:8899", "http://[::1]:8899", "https://rpc.example.com"]);
  });
});
