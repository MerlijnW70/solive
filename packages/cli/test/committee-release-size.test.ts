import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, generateKeyPairSigner, getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, type KeyPairSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, IntentStatus, Kind } from "@intent-engine/core";
import { COMPUTE_BUDGET_ADDRESS, getIntentDecoder, signCommitteeVote, sortMembers } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { VOTE_KIND } from "../src/committee-commands.js";
import { NOT_SENT } from "../src/flows.js";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { announced, keyed } from "./announce.js";
import { balance, cli, funded, h, NOW, transport, world } from "./harness.js";
import { lookupTable } from "./lookup-table-kit.js";

const WORK = "ab".repeat(32);

const tablesOf = (wire: string): Address[] => {
  const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(getBase64Encoder().encode(wire)).messageBytes);
  return "addressTableLookups" in message ? (message.addressTableLookups ?? []).map((lookup) => lookup.lookupTableAddress) : [];
};

const pricesOf = (wire: string): number[] => {
  const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(getBase64Encoder().encode(wire)).messageBytes);
  const instructions = "instructions" in message ? message.instructions : [];
  return instructions.filter((ix) => message.staticAccounts[ix.programAddressIndex] === COMPUTE_BUDGET_ADDRESS && ix.data?.[0] === SET_UNIT_PRICE).map((ix) => ix.data?.length ?? 0);
};

const SET_UNIT_PRICE = 3;

async function bench(members: number, threshold: number, everyAccount: boolean) {
  const w = await world();
  const signers = await Promise.all(Array.from({ length: members }, () => generateKeyPairSigner()));
  const payer = await funded();
  const solver = await funded();
  const worker = await keyed();
  const keys: Record<string, KeyPairSigner> = { "payer.json": payer, "solver.json": solver, "admin.json": w.authority };
  const created = await cli(
    ["committee", "create", "--keypair", "payer.json", "--members", sortMembers(signers.map((s) => s.address)).join(","), "--threshold", String(threshold), "--fee-wallet", (await generateKeyPairSigner()).address, "--yes"],
    keys,
  );
  expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
  const committee = created.json()["committee"] as Address;
  if (everyAccount) {
    const capped = await cli(["set-mint-cap", "--keypair", "admin.json", "--mint", w.inputMint, "--max-per-order", "1000", "--window-cap", "1000", "--window-secs", "3600", "--yes"], keys);
    expect([capped.code, capped.err]).toEqual([EXIT_OK, ""]);
  }
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: committee, specHash: new Uint8Array(32).fill(7), judgeFee: 10n } as const;
  const partner = everyAccount ? { partner: (await generateKeyPairSigner()).address, partnerBps: 50 } : {};
  const client = createClient({ url: "http://cluster", transport });
  const { intent } = await client.createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n, ...partner });
  const made = await announced(intent, worker, WORK);
  const ballot = await client.committeeBallot({ intent: { owner: w.owner.address, nonce: 0n }, announcement: made.announcement, opening: { sha256: WORK, salt: made.salt }, result: 1n });
  const dir = await mkdtemp(join(tmpdir(), "committee-size-"));
  const files: string[] = [];
  for (const [i, member] of signers.slice(0, threshold).entries()) {
    const vote = await signCommitteeVote(member, ballot.digest, ballot.committee.members);
    const file = join(dir, `v${i}.json`);
    const fields = { kind: VOTE_KIND, intent, committee, owner: w.owner.address, nonce: "0", announcement: made.announcement, sha256: WORK, salt: made.salt, result: "1" };
    await writeFile(file, JSON.stringify({ ...fields, member: vote.member, signature: Buffer.from(vote.signature).toString("hex") }));
    files.push(file);
  }
  const paid = async () => balance(await findAssociatedTokenAddress({ owner: worker.address, mint: w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }));
  const status = () => {
    const view = h.svm.getAccount(intent);
    return view.exists ? getIntentDecoder().decode(view.data).status : undefined;
  };
  const release = ["committee", "release", "--keypair", "solver.json", ...files.flatMap((file) => ["--vote", file])];
  return { keys, committee, release, paid, status };
}

describe("committee release on the command line at the packet limit", () => {
  for (const [members, threshold, everyAccount] of [
    [6, 3, false],
    [8, 3, true],
  ] as const) {
    it(`refuses a ${threshold}-of-${members} release${everyAccount ? " with a partner and a mint cap" : ""} that cannot land without a table, and lands it through --lookup-table`, async () => {
      const b = await bench(members, threshold, everyAccount);
      const bare = await cli(b.release, b.keys);
      expect([bare.code, bare.err]).toEqual([EXIT_OK, ""]);
      expect(bare.json()).toMatchObject({
        sent: false,
        next: expect.stringMatching(/^ReleaseTooLarge: this committee release builds a \d+-byte transaction, over the 1232-byte limit; pass --lookup-table with an address lookup table holding the lookup_accounts this preview prints; nothing was sent$/),
      });
      const wires = h.wires.length;
      const refused = await cli([...b.release, "--yes"], b.keys);
      expect([refused.code, refused.err]).toEqual([EXIT_FAILED, expect.stringMatching(/^ReleaseTooLarge: this committee release builds a \d+-byte transaction/)]);
      expect(h.wires.length).toBe(wires);
      expect(b.status()).toBe(IntentStatus.Open);
      expect(await b.paid()).toBeLessThan(1n);
      const lookups = bare.json()["lookup_accounts"] as Address[];
      expect(lookups).toContain(b.committee);
      const table = (await generateKeyPairSigner()).address;
      lookupTable(lookups, table);
      const tabled = await cli([...b.release, "--lookup-table", table], b.keys);
      expect(tabled.json()).toMatchObject({ sent: false, next: NOT_SENT, lookup_table: table, summary: expect.arrayContaining([`Looks up: accounts in the address lookup table ${table}`]) });
      const sent = await cli([...b.release, "--lookup-table", table, "--yes"], b.keys);
      expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
      expect(sent.json()).toMatchObject({ sent: true, signature: expect.any(String), lookup_table: table });
      expect(tablesOf(h.wires.at(-1) ?? "")).toEqual([table]);
      expect(b.status()).toBe(IntentStatus.Filled);
      expect(await b.paid()).toBeGreaterThan(0n);
    });
  }

  it("names an empty or wrong table as too large even with it, and sends a small committee without one", async () => {
    const b = await bench(8, 3, true);
    const idle = (await generateKeyPairSigner()).address;
    lookupTable([(await generateKeyPairSigner()).address], idle);
    const useless = await cli([...b.release, "--lookup-table", idle, "--yes"], b.keys);
    expect([useless.code, useless.err]).toEqual([EXIT_FAILED, expect.stringMatching(/^ReleaseTooLarge: .*; even with the lookup table, so it cannot be sent; nothing was sent$/)]);
    expect(b.status()).toBe(IntentStatus.Open);
    const missing = await cli([...b.release, "--lookup-table", (await generateKeyPairSigner()).address, "--yes"], b.keys);
    expect([missing.code, missing.err]).toEqual([EXIT_FAILED, expect.stringContaining("no lookup table")]);
    const small = await bench(2, 2, false);
    const sent = await cli([...small.release, "--yes"], small.keys);
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(tablesOf(h.wires.at(-1) ?? "")).toEqual([]);
    expect(small.status()).toBe(IntentStatus.Filled);
  });

  it("sends the release with the very budget it measured even when the priority price moves between the two", async () => {
    const b = await bench(8, 3, true);
    let asked = 0;
    h.through = {
      ...transport,
      recentFees: async () => {
        asked += 1;
        return asked > 1 ? [1_000_000n] : [];
      },
    };
    const bare = (await cli(b.release, b.keys)).json();
    const table = (await generateKeyPairSigner()).address;
    lookupTable(bare["lookup_accounts"] as Address[], table);
    asked = 0;
    const sent = await cli([...b.release, "--lookup-table", table, "--priority-fee", "auto", "--yes"], b.keys);
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(asked).toBeGreaterThan(1);
    expect(pricesOf(h.wires.at(-1) ?? "")).toEqual([]);
    expect(b.status()).toBe(IntentStatus.Filled);
  });
});
