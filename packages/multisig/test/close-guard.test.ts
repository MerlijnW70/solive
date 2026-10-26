import { AccountRole, type Address, type Instruction } from "@solana/kit";
import { DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH, TESTNET_GENESIS_HASH } from "@intent-engine/client/internal";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { describeInstructions } from "../src/review.js";
import { EXIT_OK, EXIT_REFUSED, EXIT_USAGE } from "../src/main.js";
import { CLOSE_TAG, ENGINE_CLOSE, ENGINE_PROGRAM, LOADER, programDataOf } from "../src/squads.js";
import { randomAddress } from "./svm.js";
import {
  approveDirectly,
  bufferHeldBy,
  bytesOf,
  craftVault,
  header,
  type Made,
  multisig,
  openSvm,
  proposalOf,
  s,
  SQUADS_SITE,
  upgradeable,
} from "./multisig-world.js";

const LOCKED_FOR_GOOD = "the program can never run again and every escrow it holds is locked for good";

let engineData: Address;

beforeAll(async () => {
  await openSvm();
  engineData = await programDataOf(ENGINE_PROGRAM);
  s.set(engineData, LOADER, header(3, [new Uint8Array(8), new Uint8Array([1]), bytesOf(await randomAddress()), new Uint8Array(16)]));
});

afterEach(() => {
  s.genesis = DEVNET_GENESIS_HASH;
});

const close = (closed: Address, recipient: Address, authority?: Address, program?: Address): Instruction => ({
  programAddress: LOADER,
  accounts: [
    { address: closed, role: AccountRole.WRITABLE },
    { address: recipient, role: AccountRole.WRITABLE },
    ...(authority === undefined ? [] : [{ address: authority, role: AccountRole.READONLY_SIGNER }]),
    ...(program === undefined ? [] : [{ address: program, role: AccountRole.WRITABLE }]),
  ],
  data: Uint8Array.from([CLOSE_TAG, 0, 0, 0]),
});

const refusal = (index: bigint) =>
  `refusing to sign proposal ${index} on mainnet-beta: ${ENGINE_CLOSE}; inspect it in the Squads app at ${SQUADS_SITE} and do not approve it blindly, and pass --allow-engine-close only if the engine is meant to end for good`;

async function engineCloseProposal(tag: string): Promise<{ m: Made; index: bigint; on: string[] }> {
  const m = await multisig(tag, 2);
  const index = await craftVault(m, [close(engineData, m.vault, m.vault, ENGINE_PROGRAM)]);
  return { m, index, on: ["--multisig", m.address, "--index", index.toString()] };
}

describe("loader close", () => {
  it("the review names the closed account, the recipient, the authority and the program, and warns only for the engine's data", async () => {
    const vault = await randomAddress();
    const recipient = await randomAddress();
    const program = await upgradeable(vault);
    const programData = await programDataOf(program);
    const buffer = await bufferHeldBy(vault, Uint8Array.from([1, 2, 3]));
    const nothing = await randomAddress();
    const unsigned: Instruction = { ...close(buffer, recipient), accounts: [...(close(buffer, recipient).accounts ?? []), { address: vault, role: AccountRole.READONLY }] };
    const tail = `; its lamports go to ${recipient}; authority ${vault}`;
    const { decoded, engineClose, problems } = await describeInstructions(s.chain, [close(engineData, recipient, vault, ENGINE_PROGRAM)]);
    expect([decoded.map((d) => d.summary), engineClose, problems]).toEqual([[`${ENGINE_CLOSE}${tail}`], ENGINE_CLOSE, []]);
    expect(ENGINE_CLOSE).toBe(`Closes the program data of the intent engine ${ENGINE_PROGRAM}: ${LOCKED_FOR_GOOD}`);

    const others = await describeInstructions(s.chain, [
      close(buffer, recipient, vault),
      close(programData, recipient, vault, program),
      close(programData, recipient, vault),
      close(programData, recipient, vault, ENGINE_PROGRAM),
      close(nothing, recipient, vault),
      unsigned,
      close(buffer, recipient),
      { ...close(buffer, recipient, vault), data: Uint8Array.from([CLOSE_TAG, 0, 0, 0, 7]) },
      { ...close(buffer, recipient), accounts: (close(buffer, recipient).accounts ?? []).slice(0, 1) },
    ]);
    expect(others.decoded.map((d) => d.summary)).toEqual([
      `Closes buffer ${buffer}, controlled by ${vault}${tail}`,
      `Closes the program data ${programData} of program ${program}: that program can never run again${tail}`,
      `Closes the program data ${programData} without naming its program, so the loader refuses it${tail}`,
      `Closes the program data ${programData} of program ${ENGINE_PROGRAM}, which is not that program's data, so the loader refuses it: that program can never run again${tail}`,
      `Closes account ${nothing}, which is neither a buffer nor a program's data${tail}`,
      `Closes buffer ${buffer}, controlled by ${vault}; its lamports go to ${recipient}; authority ${vault}; ${vault} does not sign, so the loader refuses it`,
      `Closes buffer ${buffer}, controlled by ${vault}; its lamports go to ${recipient}; it names no authority`,
      `Closes buffer ${buffer}, controlled by ${vault}${tail}; the instruction carries 1 more bytes of data, which the loader ignores`,
      "Loader Close with only 1 accounts, so the loader refuses it",
    ]);
    expect([others.engineClose, others.problems]).toEqual([null, []]);

    const strays = await describeInstructions(s.chain, [close(engineData, recipient, vault), close(engineData, recipient, vault, program)]);
    expect(strays.decoded.map((d) => d.summary)).toEqual([
      `${ENGINE_CLOSE}; it names no program, so the loader refuses it${tail}`,
      `${ENGINE_CLOSE}; it names program ${program} instead, so the loader refuses it${tail}`,
    ]);
    expect(strays.engineClose).toBe(ENGINE_CLOSE);
  });

  it("approve on mainnet-beta refuses closing the engine's data without allow engine close and signs it with the flag", async () => {
    const { m, index, on } = await engineCloseProposal("mainnet");
    s.genesis = MAINNET_GENESIS_HASH;
    const refused = await s.cli("approve", ...on, "--keypair", m.file("a"), "--yes");
    expect([refused.code, refused.json()["error"], refused.json()["refused"]]).toEqual([EXIT_REFUSED, refusal(index), true]);
    expect(refused.json()["proposal"]["warning"]).toBe(ENGINE_CLOSE);
    expect((await proposalOf(m, index))["approved"]).toEqual([]);

    const allowed = await s.cli("approve", ...on, "--allow-engine-close", "--keypair", m.file("a"), "--yes");
    expect([allowed.code, allowed.err]).toEqual([EXIT_OK, ""]);
    expect(allowed.json()["summary"][0]).toBe(`Warning: ${ENGINE_CLOSE}`);
    expect(allowed.json()["summary"]).toContain(`${ENGINE_CLOSE}; its lamports go to ${m.vault}; authority ${m.vault}`);
    expect((await proposalOf(m, index))["approved"]).toEqual([m.members[0]?.address]);
  });

  it("execute on mainnet-beta refuses closing the engine's data without allow engine close", async () => {
    const { m, index, on } = await engineCloseProposal("mainexec");
    await approveDirectly(m, index, ["a", "b"]);
    s.genesis = MAINNET_GENESIS_HASH;
    const refused = await s.cli("execute", ...on, "--keypair", m.file("a"));
    expect([refused.code, refused.json()["error"]]).toEqual([EXIT_REFUSED, refusal(index)]);
    const allowed = await s.cli("execute", ...on, "--allow-engine-close", "--keypair", m.file("a"));
    expect([allowed.code, allowed.json()["sent"], allowed.json()["summary"][0]]).toEqual([EXIT_OK, false, `Warning: ${ENGINE_CLOSE}`]);
  });

  it("approve on devnet and every other cluster signs the engine close with the warning printed", async () => {
    const { m, index, on } = await engineCloseProposal("devnet");
    for (const genesis of [TESTNET_GENESIS_HASH, "LocaLGenesis1111111111111111111111111111111"]) {
      s.genesis = genesis;
      const preview = await s.cli("approve", ...on, "--keypair", m.file("b"));
      expect([preview.code, preview.json()["sent"], preview.json()["simulation"], preview.json()["summary"][0]]).toEqual([EXIT_OK, false, "ok", `Warning: ${ENGINE_CLOSE}`]);
    }
    s.genesis = DEVNET_GENESIS_HASH;
    const approved = await s.cli("approve", ...on, "--keypair", m.file("a"), "--yes");
    expect([approved.code, approved.err, approved.json()["sent"]]).toEqual([EXIT_OK, "", true]);
    expect(approved.json()["summary"][0]).toBe(`Warning: ${ENGINE_CLOSE}`);
    expect(approved.json()["proposal"]["warning"]).toBe(ENGINE_CLOSE);
    expect((await proposalOf(m, index))["approved"]).toEqual([m.members[0]?.address]);
    await approveDirectly(m, index, ["b"]);
    const executed = await s.cli("execute", ...on, "--keypair", m.file("b"));
    expect([executed.code, executed.json()["summary"][0]]).toEqual([EXIT_OK, `Warning: ${ENGINE_CLOSE}`]);
  });

  it("show prints the warning on every cluster", async () => {
    const { m, index } = await engineCloseProposal("show");
    for (const genesis of [MAINNET_GENESIS_HASH, DEVNET_GENESIS_HASH]) {
      s.genesis = genesis;
      const shown = await proposalOf(m, index);
      expect([shown["warning"], shown["summary"], shown["problems"]]).toEqual([ENGINE_CLOSE, [`${ENGINE_CLOSE}; its lamports go to ${m.vault}; authority ${m.vault}`], undefined]);
    }
  });

  it("a buffer close on mainnet-beta is shown and approved without the flag", async () => {
    const m = await multisig("buffer", 2);
    const buffer = await bufferHeldBy(m.vault, Uint8Array.from([4, 5, 6]));
    const index = await craftVault(m, [close(buffer, m.vault, m.vault)]);
    s.genesis = MAINNET_GENESIS_HASH;
    const approved = await s.cli("approve", "--multisig", m.address, "--index", index.toString(), "--keypair", m.file("a"), "--yes");
    expect([approved.code, approved.err, approved.json()["sent"]]).toEqual([EXIT_OK, "", true]);
    expect(approved.json()["summary"]).toEqual([
      `Approves proposal ${index} on multisig ${m.address} as ${m.members[0]?.address}`,
      "This is approval 1 of 2",
      `Closes buffer ${buffer}, controlled by ${m.vault}; its lamports go to ${m.vault}; authority ${m.vault}`,
    ]);
    expect(approved.json()["proposal"]["warning"]).toBeUndefined();
  });

  it("reject and show take no allow engine close", async () => {
    const { m, on } = await engineCloseProposal("flags");
    const rejected = await s.cli("reject", ...on, "--allow-engine-close", "--keypair", m.file("a"));
    expect([rejected.code, rejected.json()["error"]]).toEqual([EXIT_USAGE, "reject takes no --allow-config, --allow-engine-close, --allow-undecoded-vault-signer or --allow-rewritten-buffer"]);
    const shown = await s.cli("show", ...on, "--allow-engine-close");
    expect([shown.code, shown.json()["error"]]).toEqual([
      EXIT_USAGE,
      "show only reads; it takes no --keypair, --yes, --allow-config, --allow-engine-close, --allow-undecoded-vault-signer, --allow-rewritten-buffer or --expect-buffer-hash",
    ]);
  });
});
