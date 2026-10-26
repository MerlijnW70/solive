import { deflateSync } from "node:zlib";
import { AccountRole, type Instruction } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { EXIT_OK, EXIT_REFUSED } from "../src/main.js";
import { canonicalMetadata, PROGRAM_METADATA } from "../src/program-metadata-layout.js";
import { rewrittenText } from "../src/proposal-effects.js";
import { ENGINE_PROGRAM } from "../src/squads.js";
import { craftVault, multisig, openSvm, proposalOf, s, SQUADS_SITE } from "./multisig-world.js";
import {
  concat,
  digest,
  engineUpgradedBy,
  idlBuffer,
  loadProgramMetadata,
  LOCAL_HASH,
  LOCAL_IDL,
  meta,
  onChainIdl,
  placeMetadata,
  rentOf,
  sameSizeForgery,
  setDataFromBuffer,
  transferIx,
  u32,
  writeBuffer,
} from "./program-metadata-world.js";

beforeAll(async () => {
  await openSvm();
  loadProgramMetadata();
  s.svm.warpToSlot(10n);
});

const OLD_IDL = LOCAL_IDL.subarray(0, Math.floor(LOCAL_IDL.length / 2));

describe("an IDL update proposal that rewrites the reviewed buffer before it sets the IDL", () => {
  it("MS-2: approve refuses it, shows the forged hash under --allow-rewritten-buffer, and execute refuses it against the approved hash", async () => {
    const m = await multisig("ms-idl", 2);
    s.fund(m.vault);
    await engineUpgradedBy(m.vault);
    const metadata = await placeMetadata({ content: OLD_IDL });
    expect(metadata).toBe(await canonicalMetadata(ENGINE_PROGRAM));
    const deployer = await s.member("ms-idl-deployer.json");
    const buffer = await idlBuffer(deployer, LOCAL_IDL, m.vault);
    const forged = sameSizeForgery(LOCAL_IDL);
    expect(digest(forged)).not.toBe(LOCAL_HASH);
    const rogue = await s.member("ms-idl-rogue.json");
    const source = await writeBuffer(rogue, deflateSync(forged));

    const topUp = transferIx(m.vault, metadata, rentOf(deflateSync(LOCAL_IDL).length) - rentOf(deflateSync(OLD_IDL).length));
    const overwrite: Instruction = {
      programAddress: PROGRAM_METADATA,
      accounts: [meta(buffer, AccountRole.WRITABLE), meta(m.vault, AccountRole.READONLY_SIGNER), meta(source)],
      data: concat([0], u32(0)),
    };
    const index = await craftVault(m, [topUp, overwrite, await setDataFromBuffer(metadata, m.vault, buffer)]);
    const on = ["--multisig", m.address, "--index", index.toString()];
    const problem = rewrittenText(3, buffer, [2], "idl");

    const shown = await proposalOf(m, index);
    expect([shown["problems"], shown["buffers"]]).toEqual([[problem], [{ buffer, authority: m.vault, hash: null, sets: "idl", writtenBy: [2] }]]);
    const setSummary = shown["summary"][2] as string;
    expect([setSummary.includes(`with sha256 ${LOCAL_HASH}`), setSummary.endsWith("; but instruction 2 of the same proposal may write the buffer first, so that is the buffer before the transaction, not what this instruction reads")]).toEqual([true, true]);

    for (const name of ["b", "c"]) {
      const refused = await s.cli("approve", ...on, "--keypair", m.file(name), "--yes");
      expect([refused.code, refused.json()["error"]]).toEqual([
        EXIT_REFUSED,
        `refusing to sign proposal ${index}: ${problem}; inspect it in the Squads app at ${SQUADS_SITE} and do not approve it blindly, and pass --allow-rewritten-buffer only to sign on the hash the simulated transaction sets, which approve then prints as buffer_hash`,
      ]);
    }
    expect((await proposalOf(m, index))["approved"]).toEqual([]);

    const forgedSet = { simulation: "ok", sets: [{ account: metadata, sets: "idl", hash: digest(forged) }] };
    for (const name of ["b", "c"]) {
      const approved = await s.cli("approve", ...on, "--allow-rewritten-buffer", "--keypair", m.file(name), "--yes");
      expect([approved.code, approved.err, approved.json()["buffer_hash"], approved.json()["post_state"]]).toEqual([EXIT_OK, "", digest(forged), forgedSet]);
      expect(approved.json()["summary"].at(-1)).toBe(`Simulated, the proposal sets the IDL account ${metadata} to IDL bytes with sha256 ${digest(forged)}`);
    }

    const unflagged = await s.cli("execute", ...on, "--expect-buffer-hash", LOCAL_HASH, "--keypair", m.file("c"), "--yes");
    expect([unflagged.code, unflagged.json()["error"]]).toEqual([EXIT_REFUSED, expect.stringContaining(`refusing to sign proposal ${index}: ${problem}`)]);
    const refused = await s.cli("execute", ...on, "--expect-buffer-hash", LOCAL_HASH, "--allow-rewritten-buffer", "--keypair", m.file("c"), "--yes");
    expect([refused.code, refused.json()["error"], refused.json()["post_state"]]).toEqual([
      EXIT_REFUSED,
      `simulated, the execute transaction sets the IDL account ${metadata} to IDL bytes with sha256 ${digest(forged)}, not the approved ${LOCAL_HASH}; do not execute it`,
      forgedSet,
    ]);
    expect(onChainIdl(metadata)).toEqual(OLD_IDL);
    expect((await proposalOf(m, index))["status"]).toBe("approved");

    const executed = await s.cli("execute", ...on, "--expect-buffer-hash", digest(forged), "--allow-rewritten-buffer", "--keypair", m.file("c"), "--yes");
    expect([executed.code, executed.err, executed.json()["post_state"]]).toEqual([EXIT_OK, "", forgedSet]);
    expect(digest(onChainIdl(metadata))).toBe(digest(forged));
  });
});
