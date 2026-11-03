import {
  type Address,
  type Base64EncodedWireTransaction,
  type Blockhash,
  generateKeyPairSigner,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type KeyPairSigner,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { expect } from "vitest";
import { type Config, type Intent, IntentStatus, Kind } from "@intent-engine/core";
import { encodeParams } from "@intent-engine/core/internal";
import { type Chain, type Pricer, type Quote, type QuoteRequest, type Report, type SolverOptions, tick } from "../src/index.js";

const KEY = "11111111111111111111111111111112" as Address;
export const NOW = 1_700_000_000n;
export const AMOUNT = 100_000n;
export const MIN_OUT = 90_000n;
export const FLOOR = 2n;
export const PLENTY = 10n ** 18n;

export type Order = { address: Address; intent: Intent };

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

export async function turns(count = 50): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await turn();
  }
}

export async function until(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 100_000 && !ready(); i += 1) {
    await turn();
  }
  expect(ready()).toBe(true);
}

export const fresh = async (): Promise<Address> => (await generateKeyPairSigner()).address;

export async function order(outputMint: Address, over: Partial<Intent> = {}): Promise<Order> {
  return {
    address: await fresh(),
    intent: {
      discriminator: new Uint8Array(8),
      owner: await fresh(),
      inputMint: await fresh(),
      outputMint,
      receiver: KEY,
      nonce: 1n,
      escrowed: AMOUNT,
      createdAt: NOW,
      expiresAt: NOW + 600n,
      kind: Kind.SwapExactIn,
      status: IntentStatus.Open,
      bump: 255,
      vaultBump: 255,
      version: 2,
      held: 0,
      flags: 0,
      params: encodeParams({ kind: Kind.SwapExactIn, amountIn: AMOUNT, minOut: MIN_OUT }),
      rentPayer: KEY,
      filled: 0n,
      revision: 0,
      partnerBps: 0,
      partnerCutBps: 0,
      inFlight: 0n,
      partner: KEY,
      bounty: 0,
      mandate: "11111111111111111111111111111111" as Address,
      feeBps: 5,
      gap: new Uint8Array(2),
      mandateSerial: 0n,
      agentFee: 0n,
      claims: 0,
      gap2: new Uint8Array(7),
      capped: 0n,
      ...over,
    },
  };
}

const config = (feeRecipient: Address): Config => ({
  discriminator: new Uint8Array(8),
  admin: KEY,
  pendingAdmin: KEY,
  guardian: KEY,
  feeRecipient,
  enabledKinds: 0b1_1110n,
  feeBps: 5,
  paused: 0,
  version: 2,
  bump: 255,
  kindFeeMask: 0,
  partnerCutBps: 0,
  domain: new Uint8Array(32),
  fillDisabledKinds: 0n,
  kindFeeBps: [0, 0, 0, 0],
  crankBounty: 0,
  createFee: 0,
  capsRequired: 0,
  padding: new Uint8Array(3),
  announceFee: 0,
  floorMints: [],
  floorAmounts: [],
});

export const paying = (request: QuoteRequest, profit: bigint): Quote => ({
  amountIn: request.amountIn,
  amountOut: MIN_OUT + profit,
  instructions: [],
  lookupTables: [],
});

export type World = {
  orders: Order[];
  output: Address;
  solver: KeyPairSigner;
  started: Address[];
  sends: Address[];
  log: string[];
  events: string[];
  configReads: number;
  maxPlanning: number;
  maxSending: number;
  quote: (request: QuoteRequest, order: Order) => Promise<Quote | null>;
  failSimulation: (order: Order) => string | null;
  run(extra?: Partial<SolverOptions>): Promise<Report>;
};

export async function world(orders: Order[], output: Address): Promise<World> {
  const solver = await generateKeyPairSigner();
  const feeRecipient = await fresh();
  const blockhash = (await fresh()) as unknown as Blockhash;
  const byMint = new Map(orders.map((o) => [o.intent.inputMint, o]));
  let planning = 0;
  let sending = 0;
  const intentOf = (wire: Base64EncodedWireTransaction): Order => {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
    const keys = getCompiledTransactionMessageDecoder().decode(tx.messageBytes).staticAccounts;
    const found = orders.find((o) => keys.includes(o.intent.inputMint));
    if (found === undefined) {
      throw new Error("the wire fills no known order");
    }
    return found;
  };
  const w: World = {
    orders,
    output,
    solver,
    started: [],
    sends: [],
    log: [],
    events: [],
    configReads: 0,
    maxPlanning: 0,
    maxSending: 0,
    quote: async (request) => paying(request, 5n),
    failSimulation: () => null,
    run: (extra = {}) => tick({ ...options, ...extra }),
  };
  const chain: Chain = {
    config: async () => {
      w.configReads += 1;
      return config(feeRecipient);
    },
    intents: async () => orders,
    now: async () => NOW,
    tokenProgram: async (mint) => {
      const found = byMint.get(mint);
      if (found !== undefined) {
        w.started.push(found.address);
        w.events.push(`plan ${found.address}`);
        planning += 1;
        w.maxPlanning = Math.max(w.maxPlanning, planning);
      }
      return TOKEN_PROGRAM_ADDRESS;
    },
    exists: async () => true,
    lookupTables: async () => {
      planning -= 1;
      return {};
    },
    blockhash: async () => ({ blockhash, lastValidBlockHeight: 0n }),
    tokenAmount: async () => 0n,
  };
  const pricer: Pricer = {
    quote: (request) => {
      const found = byMint.get(request.inputMint);
      if (found === undefined) {
        throw new Error("no such order");
      }
      w.events.push(`quote ${found.address}`);
      return w.quote(request, found);
    },
  };
  const options: SolverOptions = {
    chain,
    pricer,
    solver,
    strategy: { minProfit: new Map([[output, FLOOR]]), maxFeeBps: 100 },
    tip: null,
    unitPrice: async () => 0n,
    simulate: async (wire) => {
      const found = intentOf(wire);
      w.log.push(`simulate ${found.address}`);
      const err = w.failSimulation(found);
      return { err, unitsConsumed: null, balances: [PLENTY, PLENTY] };
    },
    send: async (wire) => {
      const found = intentOf(wire);
      sending += 1;
      w.maxSending = Math.max(w.maxSending, sending);
      w.log.push(`send ${found.address}`);
      await turns(5);
      w.sends.push(found.address);
      w.log.push(`sent ${found.address}`);
      sending -= 1;
      return { signature: "signature-" + found.address, confirmed: true };
    },
  };
  return w;
}

export async function many(count: number, over: (i: number) => Partial<Intent> = () => ({})): Promise<{ output: Address; orders: Order[] }> {
  const output = await fresh();
  const orders: Order[] = [];
  for (let i = 0; i < count; i += 1) {
    orders.push(await order(output, over(i)));
  }
  return { output, orders };
}

export const filledEntry = (o: Order, profit: bigint) => ({ intent: o.address, profit, cost: expect.any(BigInt), signature: "signature-" + o.address });

export type Held = { order: Order; release(): void; fail(error: unknown): void };

export function holding(w: World): Held[] {
  const held: Held[] = [];
  w.quote = (request, found) =>
    new Promise((resolve, reject) => {
      held.push({ order: found, release: () => resolve(paying(request, 5n)), fail: reject });
    });
  return held;
}
