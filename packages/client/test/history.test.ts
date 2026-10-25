import type { Address, KeyPairSigner } from "@solana/kit";
import {
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToInstruction,
} from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, Kind, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { buildCloseIntent, buildFillIntent } from "@intent-engine/core/internal";
import { createClient, type HistoryEvent, TransportLacks } from "../src/index.js";
import { HISTORY_LIMIT_MAX } from "../src/internal.js";
import { HISTORY_LIMIT_RANGE } from "../src/client-reads.js";
import { funded, world, type World } from "./svm.js";

const LOCAL = "http://127.0.0.1:8899";
const ata = (owner: Address, mint: Address) => findAssociatedTokenAddress({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });

async function holding(w: World, owner: Address, mint: Address, amount: bigint): Promise<Address> {
  const address = await ata(owner, mint);
  await w.chain.transport.send(
    [
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: w.authority, owner, mint }),
      ...(amount > 0n ? [getMintToInstruction({ mint, token: address, mintAuthority: w.authority, amount })] : []),
    ],
    w.authority,
  );
  return address;
}

async function fill(w: World, solver: KeyPairSigner, nonce: bigint, amountIn: bigint, amountOut: bigint) {
  const ref = { owner: w.owner.address, nonce, inputMint: w.inputMint };
  await w.chain.transport.send(
    [
      await buildFillIntent({
        ...ref,
        solver,
        outputMint: w.outputMint,
        inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        receiver: await ata(w.owner.address, w.outputMint),
        solverOutput: await holding(w, solver.address, w.outputMint, amountOut),
        solverInput: await holding(w, solver.address, w.inputMint, 0n),
        feeRecipient: w.feeRecipient.address,
        amountIn,
        amountOut,
        maxFeeBps: 100,
      }),
      await buildCloseIntent({ ...ref, cranker: solver, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
    ],
    solver,
  );
}

const names = (events: HistoryEvent[]) => events.map(({ name }) => name);

describe("history", () => {
  it("reads what a fill delivered after the filler closed the intent, newest first", async () => {
    const w = await world();
    await holding(w, w.feeRecipient.address, w.inputMint, 0n);
    const client = createClient({ url: LOCAL, transport: w.chain.transport });
    const swap = { kind: Kind.SwapExactIn, amountIn: 400n, minOut: 30n } as const;
    const created = await client.createIntent({ signer: w.owner, params: swap, inputMint: w.inputMint, outputMint: w.outputMint });
    const other = await client.createIntent({ signer: w.owner, params: swap, inputMint: w.inputMint, outputMint: w.outputMint });
    expect(names((await client.history(created.intent)).events)).toEqual(["IntentCreated"]);

    const solver = await funded(w.chain);
    await fill(w, solver, created.nonce, 400n, 45n);
    expect(await client.intent({ owner: w.owner.address, nonce: created.nonce })).toBeNull();

    const { events } = await client.history(created.intent);
    expect(names(events)).toEqual(["IntentClosed", "IntentFilled", "IntentCreated"]);
    const filled = events.find((event) => event.name === "IntentFilled");
    expect(filled?.fields).toMatchObject({ intent: created.intent, solver: solver.address, amountIn: 400n, delivered: 45n, required: 30n });
    expect(events[1]?.signature).toBe(events[0]?.signature);
    expect(events[2]?.signature).toBe(created.signature);
    expect(events.every(({ slot }) => typeof slot === "bigint")).toBe(true);

    expect(names((await client.history(other.intent)).events)).toEqual(["IntentCreated"]);
    expect(names((await client.history(created.intent, { limit: 1 })).events)).toEqual(["IntentClosed", "IntentFilled"]);
    expect(await client.history(solver.address)).toEqual({ events: [], next: null });
  });

  it("pages older events with before and the cursor it returns, giving every event once and in order", async () => {
    const w = await world();
    await holding(w, w.feeRecipient.address, w.inputMint, 0n);
    const client = createClient({ url: LOCAL, transport: w.chain.transport });
    const swap = { kind: Kind.SwapExactIn, amountIn: 400n, minOut: 30n } as const;
    const created = await client.createIntent({ signer: w.owner, params: swap, inputMint: w.inputMint, outputMint: w.outputMint });
    await fill(w, await funded(w.chain), created.nonce, 400n, 45n);
    const whole = (await client.history(created.intent)).events;
    const pages: HistoryEvent[][] = [];
    let before: string | undefined;
    for (;;) {
      const page = await client.history({ owner: w.owner.address, nonce: created.nonce }, { limit: 1, ...(before === undefined ? {} : { before }) });
      pages.push(page.events);
      if (page.next === null) {
        break;
      }
      before = page.next;
    }
    expect(pages.map(names)).toEqual([["IntentClosed", "IntentFilled"], ["IntentCreated"], []]);
    expect(pages.flat()).toEqual(whole);
    expect(new Set(pages.flat().map(({ signature, name }) => `${signature} ${name}`)).size).toBe(whole.length);
    expect(await client.history(created.intent, { limit: 3 })).toMatchObject({ next: null });
  });

  it("reads the newest page from a transport that cannot list signatures, and pages older only through one that can", async () => {
    const w = await world();
    await holding(w, w.feeRecipient.address, w.inputMint, 0n);
    const { signaturesOf: _, transactionsOf: __, ...plain } = w.chain.transport;
    const client = createClient({ url: LOCAL, transport: plain });
    const swap = { kind: Kind.SwapExactIn, amountIn: 400n, minOut: 30n } as const;
    const created = await client.createIntent({ signer: w.owner, params: swap, inputMint: w.inputMint, outputMint: w.outputMint });
    await fill(w, await funded(w.chain), created.nonce, 400n, 45n);
    const page = await client.history(created.intent, { limit: 1 });
    expect(names(page.events)).toEqual(["IntentClosed", "IntentFilled"]);
    expect(page.next).toBe(page.events[0]?.signature);
    await expect(client.history(created.intent, { limit: 1, before: page.next ?? "" })).rejects.toBeInstanceOf(TransportLacks);
    expect(await client.history(created.intent, { limit: 3 })).toMatchObject({ next: null });
  });

  it("refuses a page size it cannot ask the node for", async () => {
    const w = await world();
    const client = createClient({ url: LOCAL, transport: w.chain.transport });
    for (const limit of [0, 1.5, HISTORY_LIMIT_MAX + 1]) {
      await expect(client.history(w.owner.address, { limit })).rejects.toMatchObject({ field: "limit", rule: "range", message: HISTORY_LIMIT_RANGE });
    }
  });
});
