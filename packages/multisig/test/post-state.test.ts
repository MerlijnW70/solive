import { deflateSync } from "node:zlib";
import { AccountRole, type Address, type Instruction } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { EXIT_OK, EXIT_REFUSED } from "../src/main.js";
import { PROGRAM_METADATA } from "../src/program-metadata-layout.js";
import { rewrittenText } from "../src/proposal-effects.js";
import { ENGINE_PROGRAM, programDataOf, SYSVAR_RENT } from "../src/squads.js";
import { craftVault, multisig, openSvm, proposalOf, s, type Made } from "./multisig-world.js";
import {
  concat,
  digest,
  engineUpgradedBy,
  idlBuffer,
  loadProgramMetadata,
  meta,
  onChainIdl,
  placeMetadata,
  rentOf,
  sameSizeForgery,
  setDataFromBuffer,
  transferIx,
  u32,
} from "./program-metadata-world.js";

beforeAll(async () => {
  await openSvm();
  loadProgramMetadata();
  s.svm.warpToSlot(10n);
});

const OLD = new TextEncoder().encode("{}");
const HONEST = new TextEncoder().encode(JSON.stringify({ name: "intent_engine", instructions: ["fill", "cancel", "release", "expire"] }));
const FORGED = sameSizeForgery(HONEST);

type Setup = { m: Made; metadata: Address; buffer: Address; topUp: Instruction };

async function setup(tag: string): Promise<Setup> {
  const m = await multisig(tag, 2);
  s.fund(m.vault);
  await engineUpgradedBy(m.vault);
  const metadata = await placeMetadata({ content: OLD });
  const deployer = await s.member(`${tag}-deployer.json`);
  const buffer = await idlBuffer(deployer, HONEST, m.vault);
  const topUp = transferIx(m.vault, metadata, rentOf(deflateSync(HONEST).length) - rentOf(deflateSync(OLD).length) + rentOf(64) - rentOf(0));
  return { m, metadata, buffer, topUp };
}

const pm = (accounts: { address: Address; role: AccountRole }[], data: number[] | Uint8Array): Instruction => ({ programAddress: PROGRAM_METADATA, accounts, data: Uint8Array.from(data) });

const writeIx = (buffer: Address, vault: Address, offset: number, bytes: Uint8Array) =>
  pm([meta(buffer, AccountRole.WRITABLE), meta(vault, AccountRole.READONLY_SIGNER), meta(PROGRAM_METADATA)], concat([0], u32(offset), bytes));

const on = (m: Made, index: bigint) => ["--multisig", m.address, "--index", index.toString()];

const approvals = async (m: Made, index: bigint, extra: string[] = []) => {
  const out = [];
  for (const name of ["a", "b"]) {
    out.push(await s.cli("approve", ...on(m, index), ...extra, "--keypair", m.file(name), "--yes"));
  }
  return out;
};

async function refusedThenSimulated(x: Setup, writer: Instruction, before: Instruction[] = []) {
  const index = await craftVault(x.m, [x.topUp, ...before, writer, await setDataFromBuffer(x.metadata, x.m.vault, x.buffer)]);
  const writerAt = before.length + 2;
  const problem = rewrittenText(writerAt + 1, x.buffer, [writerAt], "idl");
  expect((await proposalOf(x.m, index))["problems"]).toEqual([problem]);
  const [refused] = await approvals(x.m, index);
  expect([refused?.code, refused?.json()["error"]]).toEqual([EXIT_REFUSED, expect.stringContaining(`refusing to sign proposal ${index}: ${problem}`)]);
  expect((await proposalOf(x.m, index))["approved"]).toEqual([]);
  const approved = await approvals(x.m, index, ["--allow-rewritten-buffer"]);
  const post = approved[0]?.json()["post_state"];
  expect(approved.map((a) => [a.code, a.json()["buffer_hash"]])).toEqual([
    [EXIT_OK, post["sets"][0]["hash"]],
    [EXIT_OK, post["sets"][0]["hash"]],
  ]);
  return { index, post, hash: post["sets"][0]["hash"] as string };
}

describe("an instruction that writes the buffer before SetData reads it", () => {
  it("a program-metadata Write is refused, and the hash approve shows under --allow-rewritten-buffer is the IDL execute lands", async () => {
    const x = await setup("pm-write");
    const { index, post, hash } = await refusedThenSimulated(x, writeIx(x.buffer, x.m.vault, 0, deflateSync(FORGED)));
    expect(post).toEqual({ simulation: "ok", sets: [{ account: x.metadata, sets: "idl", hash: digest(FORGED) }] });
    const refused = await s.cli("execute", ...on(x.m, index), "--expect-buffer-hash", digest(HONEST), "--allow-rewritten-buffer", "--keypair", x.m.file("c"), "--yes");
    expect([refused.code, refused.json()["error"]]).toEqual([
      EXIT_REFUSED,
      `simulated, the execute transaction sets the IDL account ${x.metadata} to IDL bytes with sha256 ${digest(FORGED)}, not the approved ${digest(HONEST)}; do not execute it`,
    ]);
    expect(onChainIdl(x.metadata)).toEqual(OLD);
    const executed = await s.cli("execute", ...on(x.m, index), "--expect-buffer-hash", hash, "--allow-rewritten-buffer", "--keypair", x.m.file("c"), "--yes");
    expect([executed.code, executed.err]).toEqual([EXIT_OK, ""]);
    expect(onChainIdl(x.metadata)).toEqual(FORGED);
  });

  it("a program-metadata Extend is refused, and the hash approve shows under --allow-rewritten-buffer is the IDL execute lands", async () => {
    const x = await setup("pm-extend");
    const fund = transferIx(x.m.vault, x.buffer, rentOf(deflateSync(HONEST).length + 64) - rentOf(deflateSync(HONEST).length));
    const extend = pm([meta(x.buffer, AccountRole.WRITABLE), meta(x.m.vault, AccountRole.READONLY_SIGNER), meta(PROGRAM_METADATA), meta(PROGRAM_METADATA)], [8, 64, 0]);
    const { index, post, hash } = await refusedThenSimulated(x, extend, [fund]);
    expect(post).toEqual({ simulation: "ok", sets: [{ account: x.metadata, sets: "idl", hash: digest(HONEST) }] });
    const executed = await s.cli("execute", ...on(x.m, index), "--expect-buffer-hash", hash, "--allow-rewritten-buffer", "--keypair", x.m.file("c"), "--yes");
    expect([executed.code, executed.err]).toEqual([EXIT_OK, ""]);
    expect(digest(onChainIdl(x.metadata))).toBe(hash);
  });

  it("a program-metadata Trim is refused, and the hash approve shows under --allow-rewritten-buffer is the IDL execute lands", async () => {
    const x = await setup("pm-trim");
    const trim = pm(
      [meta(x.buffer, AccountRole.WRITABLE), meta(x.m.vault, AccountRole.READONLY_SIGNER), meta(PROGRAM_METADATA), meta(PROGRAM_METADATA), meta(x.m.vault, AccountRole.WRITABLE), meta(SYSVAR_RENT)],
      [5],
    );
    const { index, post, hash } = await refusedThenSimulated(x, trim);
    expect(post).toEqual({ simulation: "ok", sets: [{ account: x.metadata, sets: "idl", hash: digest(HONEST) }] });
    const executed = await s.cli("execute", ...on(x.m, index), "--expect-buffer-hash", hash, "--allow-rewritten-buffer", "--keypair", x.m.file("c"), "--yes");
    expect([executed.code, executed.err]).toEqual([EXIT_OK, ""]);
    expect(digest(onChainIdl(x.metadata))).toBe(hash);
  });
});

describe("writes the review can tell apart from a rewritten buffer", () => {
  it("a transfer into the buffer and a Write into an unrelated buffer before SetData leave the honest proposal unflagged", async () => {
    const x = await setup("pm-unrelated");
    const deployer = await s.member("pm-unrelated-other.json");
    const unrelated = await idlBuffer(deployer, FORGED, x.m.vault);
    const index = await craftVault(x.m, [
      x.topUp,
      transferIx(x.m.vault, x.buffer, 1_000_000n),
      writeIx(unrelated, x.m.vault, 0, deflateSync(FORGED)),
      await setDataFromBuffer(x.metadata, x.m.vault, x.buffer),
    ]);
    const shown = await proposalOf(x.m, index);
    expect([shown["problems"], shown["buffers"]]).toEqual([undefined, [{ buffer: x.buffer, authority: x.m.vault, hash: digest(HONEST), sets: "idl" }]]);
    const honest = { simulation: "ok", sets: [{ account: x.metadata, sets: "idl", hash: digest(HONEST) }] };
    const approved = await approvals(x.m, index);
    expect(approved.map((a) => [a.code, a.err, a.json()["buffer_hash"], a.json()["post_state"]])).toEqual([
      [EXIT_OK, "", digest(HONEST), honest],
      [EXIT_OK, "", digest(HONEST), honest],
    ]);
    const executed = await s.cli("execute", ...on(x.m, index), "--expect-buffer-hash", digest(HONEST), "--keypair", x.m.file("c"), "--yes");
    expect([executed.code, executed.err, executed.json()["post_state"]]).toEqual([EXIT_OK, "", honest]);
    expect(onChainIdl(x.metadata)).toEqual(HONEST);
  });
});

describe("execute compares --expect-buffer-hash with what the simulated transaction sets", () => {
  it("refuses a proposal whose buffer hashes to the expected IDL while a later SetData sets another", async () => {
    const x = await setup("pm-second-set");
    const second = pm(
      [meta(x.metadata, AccountRole.WRITABLE), meta(x.m.vault, AccountRole.READONLY_SIGNER), meta(PROGRAM_METADATA), meta(ENGINE_PROGRAM), meta(await programDataOf(ENGINE_PROGRAM))],
      concat([3, 1, 2, 1, 0], deflateSync(FORGED)),
    );
    const index = await craftVault(x.m, [x.topUp, await setDataFromBuffer(x.metadata, x.m.vault, x.buffer), second]);
    const shown = await proposalOf(x.m, index);
    expect([shown["problems"], shown["buffers"]]).toEqual([undefined, [{ buffer: x.buffer, authority: x.m.vault, hash: digest(HONEST), sets: "idl" }]]);
    const forged = { simulation: "ok", sets: [{ account: x.metadata, sets: "idl", hash: digest(FORGED) }] };
    const approved = await approvals(x.m, index);
    expect(approved.map((a) => [a.code, a.json()["buffer_hash"], a.json()["post_state"]])).toEqual([
      [EXIT_OK, digest(FORGED), forged],
      [EXIT_OK, digest(FORGED), forged],
    ]);
    const run = ["execute", ...on(x.m, index), "--expect-buffer-hash", digest(HONEST), "--keypair", x.m.file("c")];
    const error = `simulated, the execute transaction sets the IDL account ${x.metadata} to IDL bytes with sha256 ${digest(FORGED)}, not the approved ${digest(HONEST)}; do not execute it`;
    for (const yes of [[], ["--yes"]]) {
      const refused = await s.cli(...run, ...yes);
      expect([refused.code, refused.json()["error"], refused.json()["post_state"]]).toEqual([EXIT_REFUSED, error, forged]);
    }
    expect(onChainIdl(x.metadata)).toEqual(OLD);
    expect((await proposalOf(x.m, index))["status"]).toBe("approved");
  });
});
