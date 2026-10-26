import { deflateSync, inflateSync } from "node:zlib";
import type { Address } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { EXIT_OK, EXIT_REFUSED } from "../src/main.js";
import { canonicalMetadata } from "../src/program-metadata-layout.js";
import { ENGINE_PROGRAM, programDataOf } from "../src/squads.js";
import { solText } from "../src/system-transfer.js";
import { multisig, openSvm, proposalOf, s, type Made } from "./multisig-world.js";
import {
  concat,
  digest,
  engineUpgradedBy,
  idlBuffer,
  idlUpdateExport,
  instructionList,
  loadProgramMetadata,
  LOCAL_HASH,
  LOCAL_IDL,
  placeMetadata,
  rentOf,
} from "./program-metadata-world.js";

beforeAll(async () => {
  await openSvm();
  loadProgramMetadata();
  s.svm.warpToSlot(10n);
});

const OLD_IDL = LOCAL_IDL.subarray(0, Math.floor(LOCAL_IDL.length / 2));

const onChainIdl = (at: Address): Uint8Array => {
  const held = s.account(at);
  if (!held.exists) {
    throw new Error(`${at} is closed`);
  }
  const data = held.data;
  const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(87, true);
  return new Uint8Array(inflateSync(data.subarray(96, 96 + length)));
};

const lamportsOf = (key: Address) => {
  const held = s.account(key);
  return held.exists ? held.lamports : 0n;
};

async function proposeIdlUpdate(tag: string, content: Uint8Array): Promise<{ m: Made; buffer: Address; metadata: Address; deployer: Address; topUp: bigint; stored: number }> {
  const m = await multisig(tag, 2);
  s.fund(m.vault);
  await engineUpgradedBy(m.vault);
  const metadata = await placeMetadata({ content: OLD_IDL });
  const deployer = await s.member(`${tag}-deployer.json`);
  const buffer = await idlBuffer(deployer, content, m.vault);
  const stored = deflateSync(content).length;
  const topUp = rentOf(stored) - rentOf(deflateSync(OLD_IDL).length);
  s.printed = instructionList(await idlUpdateExport({ vault: m.vault, buffer, closeTo: deployer.address, topUp }));
  const proposed = await s.cli("propose-admin", "--multisig", m.address, "--keypair", m.file("a"), "--yes", "--", "cat", "proposal.json");
  expect([proposed.code, proposed.err]).toEqual([EXIT_OK, ""]);
  return { m, buffer, metadata, deployer: deployer.address, topUp, stored };
}

describe("the IDL update scripts/idl.sh --multisig proposes", () => {
  it("is decoded in full, approved and executed without --allow-undecoded-vault-signer, and leaves the local IDL on chain", async () => {
    const { m, buffer, metadata, deployer, topUp, stored } = await proposeIdlUpdate("idl-update", LOCAL_IDL);
    expect(metadata).toBe(await canonicalMetadata(ENGINE_PROGRAM));
    const programData = await programDataOf(ENGINE_PROGRAM);
    const shown = await proposalOf(m, 1n);
    expect(shown["problems"]).toBeUndefined();
    expect(shown["buffers"]).toEqual([{ buffer, authority: m.vault, hash: LOCAL_HASH, sets: "idl" }]);
    expect(shown["summary"]).toEqual([
      `Transfers ${solText(topUp)} SOL (${topUp} lamports) from ${m.vault} to ${metadata}`,
      `Program metadata SetData: Sets the data of the canonical IDL account ${metadata} of the intent engine ${ENGINE_PROGRAM} from buffer ${buffer}, controlled by ${m.vault}, holding ${stored} bytes that decode through zlib and utf8 to ${LOCAL_IDL.length} IDL bytes with sha256 ${LOCAL_HASH}; ${m.vault} may change it as the intent engine's upgrade authority; accounts: metadata ${metadata}, authority ${m.vault} (signs), buffer ${buffer}, program ${ENGINE_PROGRAM} (the intent engine), program data ${programData} (the intent engine's); encoding utf8, compression zlib, format json, data source direct, data: none, taken from ${buffer}`,
      `Program metadata Close: Closes buffer ${buffer}, controlled by ${m.vault}; its lamports go to ${deployer}; accounts: account ${buffer}, authority ${m.vault} (signs), program: none, program data: none, destination ${deployer}; no fields`,
    ]);

    const on = ["--multisig", m.address, "--index", "1"];
    for (const name of ["a", "b"]) {
      const approved = await s.cli("approve", ...on, "--keypair", m.file(name), "--yes");
      expect([approved.code, approved.err, approved.json()["sent"], approved.json()["buffer_hash"]]).toEqual([EXIT_OK, "", true, LOCAL_HASH]);
      expect(approved.json()["summary"][0]).toBe(`Approves proposal 1 on multisig ${m.address} as ${s.keys.get(m.file(name))?.address}`);
    }
    const unhashed = await s.cli("execute", ...on, "--keypair", m.file("c"), "--yes");
    expect([unhashed.code, unhashed.json()["error"]]).toEqual([
      EXIT_REFUSED,
      "proposal 1 sets the IDL from a buffer; pass --expect-buffer-hash with the buffer hash approve printed, which equals the sha256 idl.sh printed for the local IDL file, so the IDL that is set is the IDL that was approved",
    ]);

    const refund = lamportsOf(buffer);
    const before = lamportsOf(deployer);
    const executed = await s.cli("execute", ...on, "--expect-buffer-hash", LOCAL_HASH, "--keypair", m.file("c"), "--yes");
    expect([executed.code, executed.err, executed.json()["sent"], executed.json()["buffer_hash"]]).toEqual([EXIT_OK, "", true, LOCAL_HASH]);
    expect(onChainIdl(metadata)).toEqual(LOCAL_IDL);
    expect(digest(onChainIdl(metadata))).toBe(LOCAL_HASH);
    expect(s.account(buffer).exists).toBe(false);
    expect(lamportsOf(deployer)).toBe(before + refund);
    expect((await proposalOf(m, 1n))["status"]).toBe("executed");
  });

  it("execute --expect-buffer-hash refuses a buffer whose IDL is not the expected one and leaves the IDL as it was", async () => {
    const changed = concat(LOCAL_IDL, [10]);
    const { m, buffer, metadata } = await proposeIdlUpdate("idl-changed", changed);
    const on = ["--multisig", m.address, "--index", "1"];
    for (const name of ["a", "b"]) {
      const approved = await s.cli("approve", ...on, "--keypair", m.file(name), "--yes");
      expect([approved.code, approved.json()["buffer_hash"]]).toEqual([EXIT_OK, digest(changed)]);
    }
    const refused = await s.cli("execute", ...on, "--expect-buffer-hash", LOCAL_HASH, "--keypair", m.file("c"), "--yes");
    expect([refused.code, refused.json()["error"]]).toEqual([
      EXIT_REFUSED,
      `buffer ${buffer} hashes to ${digest(changed)}, not the approved ${LOCAL_HASH}; the IDL it sets changed since approval, so do not execute it`,
    ]);
    expect(onChainIdl(metadata)).toEqual(OLD_IDL);
    expect(s.account(buffer).exists).toBe(true);
  });
});
