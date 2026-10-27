import { deflateSync } from "node:zlib";
import { AccountRole, type Address, type Instruction } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_PROGRAM } from "../../src/layout.js";
import { EXIT_OK, EXIT_REFUSED } from "../../src/main.js";
import { canonicalMetadata, PROGRAM_METADATA } from "../../src/program-metadata-layout.js";
import { ENGINE_PROGRAM, programDataOf } from "../../src/squads.js";
import { craftVault, multisig, openSvm, proposalOf, s, type Made } from "../multisig-world.js";
import { concat, digest, engineUpgradedBy, idlBuffer, loadProgramMetadata, meta, onChainIdl, placeMetadata, transferIx, u32, writeBuffer } from "../program-metadata-world.js";

beforeAll(async () => {
  await openSvm();
  loadProgramMetadata();
  s.svm.warpToSlot(10n);
});

const HONEST = new TextEncoder().encode(JSON.stringify({ name: "intent_engine", instructions: ["fill", "cancel", "release", "expire"] }));
const FORGED = new TextEncoder().encode(JSON.stringify({ name: "intent_engine", instructions: ["fill", "cancel", "release", "drain"] }));

const idlSeed = () => {
  const out = new Uint8Array(16);
  out.set(new TextEncoder().encode("idl"));
  return out;
};

const pm = (accounts: { address: Address; role: AccountRole }[], data: Uint8Array): Instruction => ({ programAddress: PROGRAM_METADATA, accounts, data });

const on = (m: Made, index: bigint) => ["--multisig", m.address, "--index", index.toString()];

const copyText = (position: number, source: Address, authority: Address) =>
  `instruction ${position} copies the data of buffer ${source}, controlled by ${authority}, not the vault, so what it writes can change after approval`;

type World = { m: Made; canonical: Address; source: Address; rogue: Address; index: bigint; writeAt: number };

async function world(tag: string, existing: boolean, vaultSource: boolean): Promise<World> {
  const m = await multisig(tag, 2);
  s.fund(m.vault);
  await engineUpgradedBy(m.vault);
  const programData = await programDataOf(ENGINE_PROGRAM);
  const canonical = await canonicalMetadata(ENGINE_PROGRAM);
  if (existing) {
    await placeMetadata({ content: new TextEncoder().encode("{}") });
  }
  const rogue = await s.member(`${tag}-rogue.json`);
  const source = vaultSource ? await idlBuffer(rogue, HONEST, m.vault) : await writeBuffer(rogue, deflateSync(HONEST));
  const access = [meta(ENGINE_PROGRAM), meta(programData)];
  const vaultSigns = meta(m.vault, AccountRole.READONLY_SIGNER);
  const close = pm([meta(canonical, AccountRole.WRITABLE), vaultSigns, ...access, meta(m.vault, AccountRole.WRITABLE)], Uint8Array.from([6]));
  const allocate = pm([meta(canonical, AccountRole.WRITABLE), vaultSigns, ...access, meta(SYSTEM_PROGRAM)], concat([7], idlSeed()));
  const write = pm([meta(canonical, AccountRole.WRITABLE), vaultSigns, meta(source)], concat([0], u32(0)));
  const initialize = pm([meta(canonical, AccountRole.WRITABLE), vaultSigns, ...access, meta(SYSTEM_PROGRAM)], concat([1], idlSeed(), [1, 2, 1, 0]));
  const index = await craftVault(m, [...(existing ? [close] : []), transferIx(m.vault, canonical, 10_000_000n), allocate, write, initialize]);
  return { m, canonical, source, rogue: rogue.address, index, writeAt: existing ? 4 : 3 };
}

async function refusedCopy(tag: string, existing: boolean): Promise<void> {
  const x = await world(tag, existing, false);
  const problem = copyText(x.writeAt, x.source, x.rogue);
  expect((await proposalOf(x.m, x.index))["problems"]).toEqual([problem]);
  for (const name of ["b", "c"]) {
    const refused = await s.cli("approve", ...on(x.m, x.index), "--keypair", x.m.file(name), "--yes", "--allow-rewritten-buffer", "--allow-undecoded-vault-signer");
    expect([refused.code, String(refused.json()["error"]).startsWith(`refusing to sign proposal ${x.index}: ${problem};`)]).toEqual([EXIT_REFUSED, true]);
  }
  expect((await proposalOf(x.m, x.index))["approved"]).toEqual([]);
}

describe("an IDL account allocated, filled by a Write from a source buffer and initialized in one proposal", () => {
  it("PS-2 refuses to approve a Write that copies a buffer the vault does not control", async () => {
    await refusedCopy("psi-two", false);
  });

  it("PS-1 approves a vault-controlled source only on the IDL hash its simulation sets, and execute needs that hash", async () => {
    const x = await world("psi-one", false, true);
    expect((await proposalOf(x.m, x.index))["problems"] ?? []).toEqual([]);
    for (const name of ["b", "c"]) {
      const approved = await s.cli("approve", ...on(x.m, x.index), "--keypair", x.m.file(name), "--yes");
      expect([approved.code, approved.json()["buffer_hash"]]).toEqual([EXIT_OK, digest(HONEST)]);
    }
    const bare = await s.cli("execute", ...on(x.m, x.index), "--keypair", x.m.file("c"), "--yes");
    expect([bare.code, bare.json()["error"]]).toEqual([
      EXIT_REFUSED,
      `proposal ${x.index} writes the IDL without a buffer; pass --expect-buffer-hash with the buffer hash approve printed, the sha256 of the IDL its simulation sets, so the IDL that is set is the IDL that was approved`,
    ]);
    const wrong = await s.cli("execute", ...on(x.m, x.index), "--expect-buffer-hash", digest(FORGED), "--keypair", x.m.file("c"), "--yes");
    expect([wrong.code, s.account(x.canonical).exists]).toEqual([EXIT_REFUSED, false]);
    const executed = await s.cli("execute", ...on(x.m, x.index), "--expect-buffer-hash", digest(HONEST), "--keypair", x.m.file("c"), "--yes");
    expect([executed.code, digest(onChainIdl(x.canonical))]).toEqual([EXIT_OK, digest(HONEST)]);
  });

  it("PS-2 refuses it too when the proposal closes and recreates the existing IDL", async () => {
    await refusedCopy("psi-closed", true);
  });
});
