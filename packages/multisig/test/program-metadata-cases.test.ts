import { deflateSync } from "node:zlib";
import { AccountRole, type Address, type Instruction } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { EXIT_OK, EXIT_REFUSED } from "../src/main.js";
import { metadataRelayedText } from "../src/program-metadata.js";
import { canonicalMetadata, PROGRAM_METADATA, PROGRAM_METADATA_CLIENT } from "../src/program-metadata-layout.js";
import { relayedText } from "../src/review.js";
import { ENGINE_PROGRAM, programDataOf } from "../src/squads.js";
import { craftVault, multisig, openSvm, proposalOf, s, SQUADS_SITE, type Made } from "./multisig-world.js";
import { bufferBytes, engineUpgradedBy, loadProgramMetadata, LOCAL_IDL, meta, placeMetadata, setAuthorityIx } from "./program-metadata-world.js";
import { randomAddress } from "./svm.js";

beforeAll(async () => {
  await openSvm();
  loadProgramMetadata();
});

const INSPECT = `inspect it in the Squads app at ${SQUADS_SITE} and do not approve it blindly`;

const needsFlag = (index: bigint, problem: string) =>
  `refusing to sign proposal ${index}: ${problem}; ${INSPECT}, and pass --allow-undecoded-vault-signer only if you trust every such program with everything the vault holds and controls`;

const setDataIx = (metadata: Address, authority: Address, buffer: Address, program: Address = ENGINE_PROGRAM, programData?: Address): Promise<Instruction> =>
  (async () => ({
    programAddress: PROGRAM_METADATA,
    accounts: [
      meta(metadata, AccountRole.WRITABLE),
      meta(authority, AccountRole.READONLY_SIGNER),
      meta(buffer, AccountRole.WRITABLE),
      meta(program),
      meta(programData ?? (await programDataOf(ENGINE_PROGRAM))),
    ],
    data: Uint8Array.from([3, 1, 2, 1, 0]),
  }))();

const closeIx = (account: Address, authority: Address, destination: Address): Instruction => ({
  programAddress: PROGRAM_METADATA,
  accounts: [meta(account, AccountRole.WRITABLE), meta(authority, AccountRole.READONLY_SIGNER), meta(PROGRAM_METADATA), meta(PROGRAM_METADATA), meta(destination, AccountRole.WRITABLE)],
  data: Uint8Array.from([6]),
});

async function world(tag: string): Promise<{ m: Made; idl: Address; buffer: Address }> {
  const m = await multisig(tag, 2);
  await engineUpgradedBy(m.vault);
  const idl = await placeMetadata({ content: LOCAL_IDL.subarray(0, 4000) });
  const buffer = await randomAddress();
  s.set(buffer, PROGRAM_METADATA, bufferBytes(m.vault, deflateSync(LOCAL_IDL)));
  return { m, idl, buffer };
}

async function approveBoth(m: Made, index: bigint, problem: string | null): Promise<void> {
  const on = ["--multisig", m.address, "--index", index.toString(), "--yes"];
  if (problem !== null) {
    const refused = await s.cli("approve", ...on, "--keypair", m.file("a"));
    expect([refused.code, refused.json()["error"], refused.json()["proposal"]["problems"]]).toEqual([EXIT_REFUSED, needsFlag(index, problem), [problem]]);
    const allowed = await s.cli("approve", ...on, "--allow-undecoded-vault-signer", "--keypair", m.file("a"));
    expect([allowed.code, allowed.err, allowed.json()["summary"][0]]).toEqual([EXIT_OK, "", `Warning: ${problem}`]);
    return;
  }
  const approved = await s.cli("approve", ...on, "--keypair", m.file("a"));
  expect([approved.code, approved.err, approved.json()["sent"]]).toEqual([EXIT_OK, "", true]);
  expect(approved.json()["proposal"]["problems"]).toBeUndefined();
}

describe("program-metadata instructions that do more than update the intent engine's IDL", () => {
  it("one on another program's metadata needs --allow-undecoded-vault-signer, even when it names the intent engine as its program", async () => {
    const { m, idl, buffer } = await world("pm-foreign");
    const other = await randomAddress();
    const foreign = await placeMetadata({ program: other, content: LOCAL_IDL.subarray(0, 4000) });
    const index = await craftVault(m, [await setDataIx(foreign, m.vault, buffer)]);
    const problem = metadataRelayedText(1, m.vault, [`it acts on ${foreign}, the canonical "idl" metadata of program ${other}, not the canonical IDL account ${idl} of the intent engine`]);
    expect((await proposalOf(m, index))["problems"]).toEqual([problem]);
    await approveBoth(m, index, problem);

    const named = await craftVault(m, [await setDataIx(foreign, m.vault, buffer, other, await programDataOf(other))]);
    const both = metadataRelayedText(1, m.vault, [
      `it acts on ${foreign}, the canonical "idl" metadata of program ${other}, not the canonical IDL account ${idl} of the intent engine`,
      `it names program ${other}, not the intent engine ${ENGINE_PROGRAM}`,
      `it names program data ${await programDataOf(other)}, not the intent engine's ${await programDataOf(ENGINE_PROGRAM)}`,
    ]);
    await approveBoth(m, named, both);
  });

  it("one that names another program for the intent engine's IDL account needs --allow-undecoded-vault-signer", async () => {
    const { m, buffer, idl } = await world("pm-program");
    const other = await randomAddress();
    const index = await craftVault(m, [await setDataIx(idl, m.vault, buffer, other)]);
    await approveBoth(m, index, metadataRelayedText(1, m.vault, [`it names program ${other}, not the intent engine ${ENGINE_PROGRAM}`]));
  });

  it("one that hands the IDL's metadata authority to a key other than the vault needs --allow-undecoded-vault-signer; handing it to the vault does not", async () => {
    const { m, idl } = await world("pm-authority");
    const stranger = await randomAddress();
    const programData = await programDataOf(ENGINE_PROGRAM);
    const away = await craftVault(m, [setAuthorityIx(idl, m.vault, stranger, ENGINE_PROGRAM, programData)]);
    await approveBoth(m, away, metadataRelayedText(1, m.vault, [`it hands the authority of the canonical IDL account ${idl} of the intent engine ${ENGINE_PROGRAM} to ${stranger}, not the vault`]));
    const dropped = await craftVault(m, [setAuthorityIx(idl, m.vault, null, ENGINE_PROGRAM, programData)]);
    await approveBoth(m, dropped, metadataRelayedText(1, m.vault, [`it hands the authority of the canonical IDL account ${idl} of the intent engine ${ENGINE_PROGRAM} to nobody but the program's upgrade authority, not the vault`]));
    const kept = await craftVault(m, [setAuthorityIx(idl, m.vault, m.vault, ENGINE_PROGRAM, programData)]);
    await approveBoth(m, kept, null);
  });

  it("one that closes the IDL account with its lamports going outside the vault needs --allow-undecoded-vault-signer; closing it into the vault does not", async () => {
    const { m, idl } = await world("pm-close");
    const outside = await randomAddress();
    const leaking = await craftVault(m, [closeIx(idl, m.vault, outside)]);
    await approveBoth(m, leaking, metadataRelayedText(1, m.vault, [`it closes the IDL account and sends its lamports to ${outside}, outside the vault`]));
    const home = await craftVault(m, [closeIx(idl, m.vault, m.vault)]);
    await approveBoth(m, home, null);
    const shown = await proposalOf(m, home);
    expect(shown["summary"][0]).toContain(`Program metadata Close: Closes the canonical IDL account ${idl} of the intent engine ${ENGINE_PROGRAM}; its lamports go to ${m.vault}`);
  });

  it("an instruction of a program the review does not decode still needs --allow-undecoded-vault-signer next to a decoded IDL update", async () => {
    const { m, idl, buffer } = await world("pm-undecoded");
    const unknown = await randomAddress();
    const relay: Instruction = { programAddress: unknown, accounts: [meta(m.vault, AccountRole.WRITABLE_SIGNER)], data: Uint8Array.from([1]) };
    const index = await craftVault(m, [await setDataIx(idl, m.vault, buffer), relay]);
    await approveBoth(m, index, relayedText(2, m.vault, unknown));
  });

  it("a program-metadata instruction that does not decode is refused even with --allow-undecoded-vault-signer", async () => {
    const { m, idl, buffer } = await world("pm-malformed");
    const unknownTag: Instruction = { programAddress: PROGRAM_METADATA, accounts: [meta(idl, AccountRole.WRITABLE), meta(m.vault, AccountRole.READONLY_SIGNER)], data: Uint8Array.from([9]) };
    const short = { ...(await setDataIx(idl, m.vault, buffer)), data: Uint8Array.from([3, 1, 2, 7, 0]) };
    const index = await craftVault(m, [unknownTag, short]);
    const problems = [
      `instruction 1 is a program-metadata instruction that does not decode at the ${PROGRAM_METADATA_CLIENT} layout (its discriminator 9 names no instruction), so approving it would sign for an effect the tool cannot show`,
      `instruction 2 is a program-metadata instruction that does not decode at the ${PROGRAM_METADATA_CLIENT} layout (SetData: its format is 7, which is not one of none, json, yaml, toml), so approving it would sign for an effect the tool cannot show`,
    ];
    for (const flags of [[], ["--allow-undecoded-vault-signer"]]) {
      const refused = await s.cli("approve", "--multisig", m.address, "--index", index.toString(), ...flags, "--keypair", m.file("a"), "--yes");
      expect([refused.code, refused.json()["error"]]).toEqual([EXIT_REFUSED, `refusing to sign proposal ${index}: ${problems.join("; ")}; ${INSPECT}`]);
    }
  });

  it("says when the vault is not the IDL account's authority, and refuses a buffer the vault does not control", async () => {
    const { m, idl } = await world("pm-not-authority");
    const upgrader = await randomAddress();
    await engineUpgradedBy(upgrader);
    const rogue = await randomAddress();
    const buffer = await randomAddress();
    s.set(buffer, PROGRAM_METADATA, bufferBytes(rogue, deflateSync(LOCAL_IDL)));
    const index = await craftVault(m, [await setDataIx(idl, m.vault, buffer)]);
    const shown = await proposalOf(m, index);
    expect(shown["summary"][0]).toContain(`; ${m.vault} is not its authority: it names no authority of its own and the intent engine is upgraded by ${upgrader}, so the program refuses it; accounts:`);
    expect(shown["problems"]).toEqual([`buffer ${buffer} is controlled by ${rogue}, not the vault ${m.vault}, so the IDL it sets can change after approval`]);
    expect(await canonicalMetadata(ENGINE_PROGRAM)).toBe(idl);
  });
});
