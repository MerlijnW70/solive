import {
  type Address,
  type Base64EncodedWireTransaction,
  type Blockhash,
  generateKeyPairSigner,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Signature,
} from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { testSignature } from "@intent-engine/client/testing";
import { type Config, type Intent, IntentStatus, Kind } from "@intent-engine/core";
import { encodeParams } from "@intent-engine/core/internal";
import { type Chain, FAILED_ON_CHAIN, type Flight, heldBy, type Landing, type SolverOptions } from "@intent-engine/solver";
import { type EngineTransaction, isTransactionSignature } from "@intent-engine/client";
import { parse } from "../src/args.js";
import { IN_FLIGHT_SECONDS, type SolveCommand, watchSolveWith, type WatchTransport } from "../src/solve-commands.js";

const KEY = "11111111111111111111111111111112" as Address;
const NOW = 1_700_000_000n;
const AMOUNT = 100_000n;
const MIN_OUT = 90_000n;
const PLENTY = 10n ** 18n;
const MINT = "So11111111111111111111111111111111111111112" as Address;
const SOLVE = ["solve", "--keypair", "k", "--jupiter", "https://" + "q.example", "--min-profit", `${MINT}=1`, "--watch", "--interval", "3"];

type Order = { address: Address; intent: Intent };

const fresh = async (): Promise<Address> => (await generateKeyPairSigner()).address;

async function order(outputMint: Address): Promise<Order> {
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

type Setup = {
  count: number;
  inventory?: boolean;
  jito?: boolean;
  steps?: bigint[];
  scans: number;
  answer?: (signature: string, sent: Map<string, Order>) => Landing;
  failedLater?: (signature: string) => boolean;
};

type Run = {
  orders: Order[];
  lines: Record<string, unknown>[];
  asked: string[][];
  submits: { order: number; signature: string }[];
  heldAtAsk: bigint[];
};

async function watch(setup: Setup): Promise<Run> {
  const output = await fresh();
  const solver = await generateKeyPairSigner();
  const feeRecipient = await fresh();
  const blockhash = (await fresh()) as unknown as Blockhash;
  const orders = await Promise.all(Array.from({ length: setup.count }, () => order(output)));
  const orderOf = (wire: Base64EncodedWireTransaction): Order => {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
    const keys = getCompiledTransactionMessageDecoder().decode(tx.messageBytes).staticAccounts;
    const found = orders.find((o) => keys.includes(o.intent.inputMint));
    if (found === undefined) {
      throw new Error("the wire fills no known order");
    }
    return found;
  };
  const inFlight = new Map<Address, Flight>();
  const sent = new Map<string, Order>();
  const submits: Run["submits"] = [];
  const asked: string[][] = [];
  const heldAtAsk: bigint[] = [];
  const submit = (wire: Base64EncodedWireTransaction): Signature => {
    const found = orderOf(wire);
    const signature = testSignature(`sig-${orders.indexOf(found)}-${submits.length}`);
    sent.set(signature, found);
    submits.push({ order: orders.indexOf(found), signature });
    return signature;
  };
  const chain: Chain = {
    config: async () => config(feeRecipient),
    intents: async () => orders,
    now: async () => NOW,
    tokenProgram: async () => TOKEN_PROGRAM_ADDRESS,
    exists: async () => true,
    lookupTables: async () => ({}),
    blockhash: async () => ({ blockhash, lastValidBlockHeight: 0n }),
    tokenAmount: async () => MIN_OUT,
  };
  const options: SolverOptions = {
    chain,
    pricer: {
      quote: async (request) => ({
        amountIn: request.amountIn,
        amountOut: MIN_OUT + 5n,
        instructions: [],
        lookupTables: [],
        ...(setup.inventory === true ? { inventory: true } : {}),
      }),
    },
    solver,
    strategy: { minProfit: new Map([[output, 2n]]), maxFeeBps: 100 },
    tip: null,
    held: heldBy(inFlight),
    unitPrice: async () => 0n,
    simulate: async () => ({ err: null, unitsConsumed: null, balances: [PLENTY, PLENTY] }),
    send: async (wire) => ({ signature: submit(wire), confirmed: false }),
  };
  const answer = setup.answer;
  const failedLater = setup.failedLater;
  const transport: WatchTransport = {
    submitWire: async (wire) => submit(wire),
    getAccounts: async (addresses) => addresses.map(() => null),
    ...(failedLater === undefined
      ? {}
      : {
          transactionOf: async (signature: string): Promise<EngineTransaction | null> =>
            failedLater(signature) && isTransactionSignature(signature) ? { signature, slot: 0n, blockTime: null, failed: true, emitted: [] } : null,
        }),
    ...(answer === undefined
      ? {}
      : {
          signatureStatuses: async (signatures: readonly string[]) => {
            asked.push([...signatures]);
            heldAtAsk.push([...inFlight.values()].reduce((total, flight) => total + (flight.holds?.amount ?? 0n), 0n));
            return signatures.map((signature) => answer(signature, sent));
          },
        }),
  };
  const flags = setup.jito === true ? ["--jito", "https://" + "jito.example"] : [];
  const command = parse([...SOLVE, ...flags], {}) as SolveCommand;
  const lines: Record<string, unknown>[] = [];
  const steps = [...(setup.steps ?? [])];
  let now = NOW;
  let waits = setup.scans - 1;
  await watchSolveWith(
    command,
    3,
    {
      now: () => now,
      intentChanges: () => ({
        wait: async () => {
          if (waits === 0) {
            return null;
          }
          waits -= 1;
          now += steps.shift() ?? 0n;
          return [];
        },
        close: () => undefined,
      }),
    },
    transport,
    options,
    (line) => lines.push(JSON.parse(JSON.stringify(line, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v)))),
    inFlight,
  );
  return { orders, lines, asked, submits, heldAtAsk };
}

const failures = (run: Run) => run.lines.flatMap((line) => (line["failed"] ?? []) as { intent: Address; error: string }[]);

describe("solve --watch learns whether a sent fill landed", () => {
  it("asks once per scan for the status of every fill still in flight", async () => {
    const run = await watch({ count: 2, scans: 3, answer: () => null });
    expect(run.submits).toHaveLength(2);
    const both = run.submits.map((s) => s.signature).sort();
    expect(run.asked.map((call) => [...call].sort())).toEqual([both, both]);
    expect(failures(run)).toEqual([]);
  });

  it("ends the flight of a landed fill on the next scan", async () => {
    const landed = new Set<string>();
    const run = await watch({
      count: 1,
      scans: 3,
      answer: (signature, sent) => {
        const found = sent.get(signature);
        if (found !== undefined) {
          found.intent = { ...found.intent, status: IntentStatus.Filled };
          landed.add(signature);
        }
        return "landed";
      },
    });
    expect(run.submits.map((s) => s.signature)).toEqual([testSignature("sig-0-0")]);
    expect(run.asked).toEqual([[testSignature("sig-0-0")]]);
    expect([...landed]).toEqual([testSignature("sig-0-0")]);
    expect(failures(run)).toEqual([]);
  });

  it("ends the flight of a failed fill on the next scan, reports it once, backs it off and frees what it held", async () => {
    const lost = new Set<string>();
    const run = await watch({
      count: 2,
      inventory: true,
      scans: 3,
      answer: (signature) => {
        if (lost.size === 0) {
          lost.add(signature);
        }
        return lost.has(signature) ? "failed" : null;
      },
    });
    const [first, second] = run.submits;
    expect(run.submits).toHaveLength(2);
    expect(second?.order).not.toBe(first?.order);
    expect(run.asked).toEqual([[first?.signature], [second?.signature]]);
    expect(run.heldAtAsk).toEqual([MIN_OUT, MIN_OUT]);
    const doomed = run.orders[first?.order ?? -1]?.address;
    expect(failures(run)).toEqual([{ intent: doomed, error: `${FAILED_ON_CHAIN}: ${first?.signature}` }]);
    expect(run.lines[1]?.["failed"]).toEqual([{ intent: doomed, error: `${FAILED_ON_CHAIN}: ${first?.signature}` }]);
  });

  it("keeps a fill the node does not know in flight until its flight ends", async () => {
    const run = await watch({ count: 1, scans: 3, steps: [1n, IN_FLIGHT_SECONDS - 1n], answer: () => null });
    expect(run.submits.map((s) => s.signature)).toEqual([testSignature("sig-0-0"), testSignature("sig-0-1")]);
    expect(run.asked).toEqual([[testSignature("sig-0-0")], [testSignature("sig-0-0")]]);
    expect(failures(run)).toEqual([]);
  });

  it("does not ask about fills sent through --jito", async () => {
    const run = await watch({ count: 2, jito: true, scans: 3, answer: () => "failed" });
    expect(run.submits).toHaveLength(2);
    expect(run.asked).toEqual([]);
    expect(failures(run)).toEqual([]);
  });

  it("without signature statuses learns of a failed fill only once its flight ends, as before", async () => {
    const early = await watch({ count: 1, scans: 2, steps: [1n], failedLater: () => true });
    expect(early.submits).toHaveLength(1);
    expect(failures(early)).toEqual([]);
    const late = await watch({ count: 1, scans: 2, steps: [IN_FLIGHT_SECONDS], failedLater: () => true });
    expect(failures(late)).toEqual([{ intent: late.orders[0]?.address, error: `${FAILED_ON_CHAIN}: ${testSignature("sig-0-0")}` }]);
    expect(late.submits).toHaveLength(1);
  });
});
