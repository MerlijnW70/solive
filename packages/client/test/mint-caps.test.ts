import { AccountRole, type Address, type Instruction } from "@solana/kit";
import { getMintToInstruction } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import {
  buildSetCapsRequired,
  buildSetMintCap,
  findAssociatedTokenAddress,
  findMintCapAddress,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  Kind,
  TOKEN_PROGRAM_ADDRESS,
} from "@intent-engine/core";
import { createClient, type CreateIntentInput, loadMintCap, mintCapOf } from "../src/index.js";
import { funded, world, type World } from "./svm.js";

const LOCAL = "http://127.0.0.1:8899";

function recording(w: World) {
  const sent: Instruction[][] = [];
  const inner = w.chain.transport;
  const client = createClient({
    url: LOCAL,
    transport: { ...inner, send: async (instructions, payer) => (sent.push([...instructions]), inner.send(instructions, payer)) },
  });
  const created = () => sent.flat().filter((ix) => ix.programAddress === INTENT_ENGINE_PROGRAM_ADDRESS).at(-1);
  return { client, created };
}

async function capped(w: World, maxPerOrder: bigint, windowCap: bigint, totalLimit = 0n) {
  await w.chain.transport.send(
    [
      await buildSetMintCap({ admin: w.authority, mint: w.inputMint, maxPerOrder, windowCap, windowSecs: 3_600, totalLimit }),
      await buildSetCapsRequired({ admin: w.authority, required: true }),
    ],
    w.authority,
  );
}

const swap = (w: World, amountIn: bigint): CreateIntentInput => ({
  signer: w.owner,
  params: { kind: Kind.SwapExactIn, amountIn, minOut: 1n },
  inputMint: w.inputMint,
  outputMint: w.outputMint,
});

describe("mint caps", () => {
  it("a create passes the mint cap when one exists", async () => {
    const w = await world();
    const { client, created } = recording(w);
    const cap = await findMintCapAddress(w.inputMint);
    expect(await mintCapOf(w.chain.transport, w.inputMint)).toBeUndefined();
    await client.createIntent(swap(w, 100n));
    expect(created()?.accounts?.map((meta) => meta.address)).not.toContain(cap);
    expect(created()?.accounts?.at(-3)).toEqual({ address: INTENT_ENGINE_PROGRAM_ADDRESS, role: AccountRole.READONLY });

    await capped(w, 300n, 500n);
    expect(await mintCapOf(w.chain.transport, w.inputMint)).toBe(cap);
    const made = await client.createIntent(swap(w, 300n));
    expect(created()?.accounts?.at(-3)).toEqual({ address: cap, role: AccountRole.WRITABLE });
    expect((await client.intent({ owner: w.owner.address, nonce: made.nonce }))?.intent.escrowed).toBe(300n);
    const held = await loadMintCap(w.chain.transport, w.inputMint);
    expect(held?.address).toBe(cap);
    expect(held?.cap).toMatchObject({ mint: w.inputMint, maxPerOrder: 300n, windowCap: 500n, windowSecs: 3_600, windowUsed: 300n });
  });

  it("a create is refused above the mint cap", async () => {
    const w = await world();
    const { client } = recording(w);
    await capped(w, 100n, 150n);
    const above = await client.createIntent(swap(w, 101n)).then(
      () => null,
      (error: unknown) => error,
    );
    expect(client.explain(above)?.name).toBe("MintCapPerOrder");
    await client.createIntent(swap(w, 100n));
    const full = await client.createIntent(swap(w, 51n)).then(
      () => null,
      (error: unknown) => error,
    );
    expect(client.explain(full)?.name).toBe("MintCapWindow");
    expect((await loadMintCap(w.chain.transport, w.inputMint))?.cap.windowUsed).toBe(100n);
  });

  it("a create past the total limit is refused and every exit gives its escrow back", async () => {
    const w = await world();
    const { client, created } = recording(w);
    const cap = await findMintCapAddress(w.inputMint);
    const outstanding = async () => (await loadMintCap(w.chain.transport, w.inputMint))?.cap.outstanding;
    await capped(w, 300n, 10_000n, 500n);
    const first = await client.createIntent(swap(w, 300n));
    const second = await client.createIntent(swap(w, 200n));
    expect(await outstanding()).toBe(500n);
    const over = await client.createIntent(swap(w, 1n)).then(
      () => null,
      (error: unknown) => error,
    );
    expect(client.explain(over)?.name).toBe("MintCapTotal");

    await client.cancel(w.owner, { owner: w.owner.address, nonce: first.nonce });
    expect(created()?.accounts?.at(-3)).toEqual({ address: cap, role: AccountRole.WRITABLE });
    expect(await outstanding()).toBe(200n);
    await client.close(w.owner, { owner: w.owner.address, nonce: first.nonce });
    expect(created()?.accounts?.at(-3)).toEqual({ address: INTENT_ENGINE_PROGRAM_ADDRESS, role: AccountRole.READONLY });

    const solver = await funded(w.chain);
    const out: Address = await findAssociatedTokenAddress({ owner: solver.address, mint: w.outputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const route = [getMintToInstruction({ mint: w.outputMint, token: out, mintAuthority: w.authority, amount: 1n })];
    await client.fill({ solver, intent: { owner: w.owner.address, nonce: second.nonce }, route });
    expect(await outstanding()).toBe(0n);
    expect((await client.intent({ owner: w.owner.address, nonce: second.nonce }))?.intent.capped).toBe(0n);
    await client.createIntent(swap(w, 300n));
    expect(await outstanding()).toBe(300n);
  });
});
