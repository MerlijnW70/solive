import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner } from "@solana/kit";
import { getMintToInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, Kind } from "@intent-engine/core";
import { createClient, jobsOf } from "../src/index.js";
import { funded, world } from "./svm.js";

const LOCAL = "http://127.0.0.1:8899";
const specHash = new Uint8Array(createHash("sha256").update("spec").digest());
const proof = (attestor: Address, amountIn: bigint) => ({ kind: Kind.AttestedResult, amountIn, minResult: 1n, maxResult: 1n, attestor, specHash, judgeFee: 0n }) as const;

async function market() {
  const w = await world();
  const client = createClient({ url: LOCAL, transport: w.chain.transport });
  const [first, second] = [await funded(w.chain), await funded(w.chain)];
  const held = await findAssociatedTokenAddress({ owner: w.owner.address, mint: w.outputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  await w.chain.transport.send([getMintToInstruction({ mint: w.outputMint, token: held, mintAuthority: w.authority, amount: 1_000n })], w.authority);
  const selling = { signer: w.owner, inputMint: w.inputMint, outputMint: w.outputMint };
  const buying = { signer: w.owner, inputMint: w.outputMint, outputMint: w.inputMint };
  const small = (await client.createIntent({ ...selling, params: proof(first.address, 100n) })).intent;
  const large = (await client.createIntent({ ...selling, params: proof(second.address, 300n) })).intent;
  const other = (await client.createIntent({ ...buying, params: proof(first.address, 500n) })).intent;
  const listed = async (filter?: Parameters<typeof client.jobs>[0]) => (await client.jobs(filter)).map(({ intent }) => intent).sort();
  return { w, client, first, second, small, large, other, listed };
}

const sorted = (...intents: Address[]) => [...intents].sort();

describe("job filters", () => {
  it("lists every job when no filter is given", async () => {
    const { w, small, large, other, listed } = await market();
    const all = sorted(small, large, other);
    expect(await listed()).toEqual(all);
    expect(await listed({})).toEqual(all);
    expect((await jobsOf(w.chain.transport)).map(({ intent }) => intent).sort()).toEqual(all);
  });

  it("keeps only jobs paid in the given mint", async () => {
    const { w, client, small, large, other, listed } = await market();
    expect(await listed({ mint: w.inputMint })).toEqual(sorted(small, large));
    expect(await listed({ mint: w.outputMint })).toEqual([other]);
    expect(await listed({ mint: (await generateKeyPairSigner()).address })).toEqual([]);
    expect((await client.jobs({ mint: w.outputMint }))[0]).toMatchObject({ inputMint: w.outputMint, sells: 500n });
  });

  it("keeps only jobs that pay at least minSells base units", async () => {
    const { small, large, other, listed } = await market();
    expect(await listed({ minSells: 0n })).toEqual(sorted(small, large, other));
    expect(await listed({ minSells: 100n })).toEqual(sorted(small, large, other));
    expect(await listed({ minSells: 101n })).toEqual(sorted(large, other));
    expect(await listed({ minSells: 300n })).toEqual(sorted(large, other));
    expect(await listed({ minSells: 500n })).toEqual([other]);
    expect(await listed({ minSells: 501n })).toEqual([]);
  });

  it("combines the judge, mint and least pay filters", async () => {
    const { w, first, second, small, large, other, listed } = await market();
    expect(await listed({ mint: w.inputMint, minSells: 200n })).toEqual([large]);
    expect(await listed({ attestor: first.address, minSells: 200n })).toEqual([other]);
    expect(await listed({ attestor: first.address, mint: w.inputMint })).toEqual([small]);
    expect(await listed({ attestor: second.address, mint: w.inputMint, minSells: 300n })).toEqual([large]);
    expect(await listed({ attestor: second.address, mint: w.outputMint })).toEqual([]);
    expect(await listed({ attestor: first.address, mint: w.outputMint, minSells: 500n })).toEqual([other]);
    expect((await jobsOf(w.chain.transport, first.address)).map(({ intent }) => intent).sort()).toEqual(sorted(small, other));
    expect((await jobsOf(w.chain.transport, { attestor: first.address, minSells: 100n })).map(({ intent }) => intent).sort()).toEqual(sorted(small, other));
  });
});
