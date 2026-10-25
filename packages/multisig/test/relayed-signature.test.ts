import { dirname, join } from "node:path";
import { AccountRole, type Address, getU64Encoder, type Instruction } from "@solana/kit";
import { DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH } from "@intent-engine/client/internal";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_PROGRAM } from "../src/layout.js";
import { EXIT_OK, EXIT_REFUSED } from "../src/main.js";
import { describeInstructions, relayedText } from "../src/review.js";
import { ENGINE_PROGRAM, programDataOf, setAuthorityInstruction } from "../src/squads.js";
import { solText } from "../src/system-transfer.js";
import { enginePath, randomAddress, SOL } from "./svm.js";
import { approveDirectly, craftVault, multisig, openSvm, proposalOf, s, SQUADS_SITE } from "./multisig-world.js";

const relayPath = join(dirname(enginePath), "cpi_relay.so");

let relay: Address;

beforeAll(async () => {
  await openSvm();
  relay = await randomAddress();
  s.svm.addProgramFromFile(relay, relayPath);
  s.svm.warpToSlot(10n);
});

afterEach(() => {
  s.genesis = DEVNET_GENESIS_HASH;
});

const transferData = (lamports: bigint) => Uint8Array.from([2, 0, 0, 0, ...getU64Encoder().encode(lamports)]);

const transfer = (from: Address, to: Address, lamports: bigint): Instruction => ({
  programAddress: SYSTEM_PROGRAM,
  accounts: [
    { address: from, role: AccountRole.WRITABLE_SIGNER },
    { address: to, role: AccountRole.WRITABLE },
  ],
  data: transferData(lamports),
});

const relayed = (vault: Address, to: Address, lamports: bigint): Instruction => ({
  programAddress: relay,
  accounts: [
    { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    { address: vault, role: AccountRole.WRITABLE_SIGNER },
    { address: to, role: AccountRole.WRITABLE },
  ],
  data: transferData(lamports),
});

const refusal = (index: bigint, problem: string) =>
  `refusing to sign proposal ${index}: ${problem}; inspect it in the Squads app at ${SQUADS_SITE} and do not approve it blindly, and pass --allow-undecoded-vault-signer only if you trust every such program with everything the vault holds and controls`;

const lamportsOf = (key: Address) => {
  const held = s.account(key);
  return held.exists ? held.lamports : 0n;
};

describe("a program the review does not decode that receives the vault's signature", () => {
  it("approve and execute refuse a relayed transfer of vault funds without allow undecoded vault signer, on devnet and mainnet-beta", async () => {
    const m = await multisig("relay-funds", 2);
    s.fund(m.vault);
    const thief = await randomAddress();
    const index = await craftVault(m, [relayed(m.vault, thief, SOL)]);
    const problem = relayedText(1, m.vault, relay);
    expect(problem).toBe(
      `instruction 1 passes the vault ${m.vault} as a signer to program ${relay}, which this tool does not decode: ${relay} receives the vault's signature and can therefore change program code, hand over the upgrade authority or move the vault's funds through calls this tool cannot show`,
    );
    const shown = await proposalOf(m, index);
    expect(shown).toMatchObject({ kind: "vault", problems: [problem] });
    expect(shown["summary"]).toEqual([`Runs program ${relay} with 3 accounts and 12 bytes of data, signed by ${m.vault}; it receives the vault's signature`]);

    const on = ["--multisig", m.address, "--index", index.toString()];
    for (const genesis of [DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH]) {
      s.genesis = genesis;
      const refused = await s.cli("approve", ...on, "--keypair", m.file("a"), "--yes");
      expect([refused.code, refused.json()["error"], refused.json()["refused"], refused.json()["proposal"]["problems"]]).toEqual([EXIT_REFUSED, refusal(index, problem), true, [problem]]);
    }
    expect((await proposalOf(m, index))["approved"]).toEqual([]);

    await approveDirectly(m, index, ["a", "b"]);
    for (const genesis of [DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH]) {
      s.genesis = genesis;
      const refused = await s.cli("execute", ...on, "--keypair", m.file("c"), "--yes");
      expect([refused.code, refused.json()["error"]]).toEqual([EXIT_REFUSED, refusal(index, problem)]);
    }
    expect(lamportsOf(thief)).toBe(0n);
    expect((await proposalOf(m, index))["status"]).toBe("approved");

    s.genesis = MAINNET_GENESIS_HASH;
    const preview = await s.cli("execute", ...on, "--allow-undecoded-vault-signer", "--keypair", m.file("c"));
    expect([preview.code, preview.json()["sent"], preview.json()["summary"][0]]).toEqual([EXIT_OK, false, `Warning: ${problem}`]);
    s.genesis = DEVNET_GENESIS_HASH;
    const executed = await s.cli("execute", ...on, "--allow-undecoded-vault-signer", "--keypair", m.file("c"), "--yes");
    expect([executed.code, executed.err, executed.json()["sent"]]).toEqual([EXIT_OK, "", true]);
    expect(lamportsOf(thief)).toBe(SOL);
  });

  it("approve signs a relayed instruction with allow undecoded vault signer and puts the warning first", async () => {
    const m = await multisig("relay-allow", 2);
    const index = await craftVault(m, [relayed(m.vault, await randomAddress(), SOL)]);
    const problem = relayedText(1, m.vault, relay);
    const allowed = await s.cli("approve", "--multisig", m.address, "--index", index.toString(), "--allow-undecoded-vault-signer", "--keypair", m.file("a"), "--yes");
    expect([allowed.code, allowed.err, allowed.json()["sent"]]).toEqual([EXIT_OK, "", true]);
    expect(allowed.json()["summary"].slice(0, 2)).toEqual([`Warning: ${problem}`, `Approves proposal ${index} on multisig ${m.address} as ${m.members[0]?.address}`]);
    expect(allowed.json()["proposal"]["problems"]).toEqual([problem]);
    expect((await proposalOf(m, index))["approved"]).toEqual([m.members[0]?.address]);
  });

  it("a system transfer from the vault is described with its amount and recipient, and approve and execute sign it", async () => {
    const m = await multisig("transfer", 2);
    s.fund(m.vault);
    const recipient = await randomAddress();
    const amount = SOL / 4n;
    const index = await craftVault(m, [transfer(m.vault, recipient, amount)]);
    const shown = await proposalOf(m, index);
    expect(shown["problems"]).toBeUndefined();
    expect(shown["summary"]).toEqual([`Transfers 0.25 SOL (250000000 lamports) from ${m.vault} to ${recipient}`]);
    const on = ["--multisig", m.address, "--index", index.toString(), "--yes"];
    for (const name of ["a", "b"]) {
      const approved = await s.cli("approve", ...on, "--keypair", m.file(name));
      expect([approved.code, approved.err, approved.json()["sent"]]).toEqual([EXIT_OK, "", true]);
    }
    const executed = await s.cli("execute", ...on, "--keypair", m.file("c"));
    expect([executed.code, executed.err, executed.json()["sent"]]).toEqual([EXIT_OK, "", true]);
    expect(lamportsOf(recipient)).toBe(amount);
  });

  it("the review decodes a system transfer in full and treats any other system instruction from the vault as undecoded", async () => {
    const vault = await randomAddress();
    const to = await randomAddress();
    const other = await randomAddress();
    const assign: Instruction = { programAddress: SYSTEM_PROGRAM, accounts: [{ address: vault, role: AccountRole.WRITABLE_SIGNER }], data: Uint8Array.from([1, 0, 0, 0, ...new Uint8Array(32)]) };
    const padded: Instruction = { ...transfer(vault, to, SOL), data: Uint8Array.from([...transferData(SOL), 0]) };
    const extra: Instruction = { ...transfer(vault, to, 1n), accounts: [...(transfer(vault, to, 1n).accounts ?? []), { address: other, role: AccountRole.READONLY }] };
    const { decoded, problems, relayed: lent } = await describeInstructions(
      s.chain,
      [
        transfer(vault, to, 3n * SOL + 5n),
        { ...transfer(vault, to, SOL), accounts: [{ address: vault, role: AccountRole.WRITABLE }, { address: to, role: AccountRole.READONLY }] },
        { ...transfer(vault, to, SOL), accounts: [{ address: vault, role: AccountRole.WRITABLE_SIGNER }] },
        extra,
        assign,
        padded,
      ],
      vault,
    );
    expect(decoded.map((d) => d.summary)).toEqual([
      `Transfers 3.000000005 SOL (3000000005 lamports) from ${vault} to ${to}`,
      `Transfers 1 SOL (1000000000 lamports) from ${vault} to ${to}; ${vault} does not sign, so the system program refuses it; ${to} is not writable, so the transfer fails`,
      "System transfer of 1 SOL with only 1 of its 2 accounts, so the system program refuses it",
      `Transfers 0.000000001 SOL (1 lamports) from ${vault} to ${to}; it passes 1 more accounts, which the system program ignores`,
      `Runs program ${SYSTEM_PROGRAM} with 1 accounts and 36 bytes of data, signed by ${vault}; it receives the vault's signature`,
      `Runs program ${SYSTEM_PROGRAM} with 2 accounts and 13 bytes of data, signed by ${vault}; it receives the vault's signature`,
    ]);
    expect([problems, lent]).toEqual([[], [relayedText(5, vault, SYSTEM_PROGRAM), relayedText(6, vault, SYSTEM_PROGRAM)]]);
    expect([solText(0n), solText(SOL * 12n), solText(SOL + SOL / 10n)]).toEqual(["0", "12", "1.1"]);
  });

  it("an instruction that does not pass the vault as a signer, and the loader with the vault, are described as before", async () => {
    const vault = await randomAddress();
    const unknown = await randomAddress();
    const someone = await randomAddress();
    const next = await randomAddress();
    const programData = await programDataOf(ENGINE_PROGRAM);
    const plain: Instruction = {
      programAddress: unknown,
      accounts: [
        { address: someone, role: AccountRole.READONLY_SIGNER },
        { address: vault, role: AccountRole.WRITABLE },
      ],
      data: Uint8Array.from([9]),
    };
    const handover = await setAuthorityInstruction({ program: ENGINE_PROGRAM, authority: vault, next });
    const seen = await describeInstructions(s.chain, [plain, handover], vault);
    expect(seen.decoded[0]?.summary).toBe(`Runs program ${unknown} with 2 accounts and 1 bytes of data, signed by ${someone}`);
    expect(seen.decoded[1]?.summary).toContain(`to ${next}`);
    expect(seen.decoded[1]?.summary).toBe((await describeInstructions(s.chain, [handover])).decoded[0]?.summary);
    expect([seen.problems, seen.relayed]).toEqual([[], []]);
    expect(programData).toBe(handover.accounts?.[0]?.address);
  });
});
