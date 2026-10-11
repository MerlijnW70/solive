import { AccountRole, type Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  ATA_CREATE,
  ATA_CREATE_IDEMPOTENT,
  type Fetch,
  JUPITER_PROGRAM,
  jupiterPricer,
  RATE_LIMITED,
  RateLimited,
  SETUP_PROGRAMS,
} from "../src/index.js";

const IN = "So11111111111111111111111111111111111111112" as Address;
const OUT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
const TAKER = "11111111111111111111111111111112" as Address;
const PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" as Address;
const TABLE = "4sKLJ1Qoudh8PJyqBeuKocYdsZvxTcRShUt9aKqwhgvC" as Address;

const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;
const SYSTEM = "11111111111111111111111111111111" as Address;

const ix = (data: string, writable: boolean, signer: boolean, programId: Address = PROGRAM) => ({
  programId,
  accounts: [{ pubkey: TAKER, isSigner: signer, isWritable: writable }],
  data,
});

const MINT_ACCOUNT = "4sKLJ1Qoudh8PJyqBeuKocYdsZvxTcRShUt9aKqwhgvD" as Address;
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const opens = (data: string, writable: boolean, signer: boolean, payer: Address = TAKER, wallet: Address = TAKER) => ({
  programId: ATA,
  accounts: [
    { pubkey: payer, isSigner: signer, isWritable: writable },
    { pubkey: MINT_ACCOUNT, isSigner: false, isWritable: true },
    { pubkey: wallet, isSigner: false, isWritable: false },
    { pubkey: OUT, isSigner: false, isWritable: false },
    { pubkey: SYSTEM, isSigner: false, isWritable: false },
    { pubkey: TOKEN, isSigner: false, isWritable: false },
  ],
  data,
});

type Call = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } };

function server(replies: { status: number; body: unknown }[]): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, ...(init === undefined ? {} : { init }) });
      const reply = replies.shift() ?? { status: 500, body: {} };
      return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body };
    },
  };
}

const quote = { inAmount: "1000", outAmount: "990", otherAmountThreshold: "985", routePlan: [] };
const built = {
  setupInstructions: [opens("AQ==", true, true)],
  swapInstruction: ix("Ag==", true, false),
  cleanupInstruction: opens("", false, true),
  addressLookupTableAddresses: [TABLE],
};
const pricer = (fetch: Fetch) =>
  jupiterPricer({ baseUrl: "https://quote.example/swap/v1", fetch, slippageBps: 30, maxAccounts: 40 });

describe("jupiter pricer", () => {
  it("quotes with the slippage-protected minimum and returns the swap with its lookup tables", async () => {
    const s = server([
      { status: 200, body: quote },
      { status: 200, body: built },
    ]);
    const q = await pricer(s.fetch).quote({ inputMint: IN, outputMint: OUT, amountIn: 1000n, taker: TAKER });
    expect(q?.amountIn).toBe(1000n);
    expect(q?.amountOut).toBe(985n);
    expect(q?.lookupTables).toEqual([TABLE]);
    expect(q?.instructions.map((i) => Array.from(i.data ?? []))).toEqual([[1], [2], []]);
    expect(q?.instructions.map((i) => i.accounts?.[0]?.role)).toEqual([
      AccountRole.WRITABLE_SIGNER,
      AccountRole.WRITABLE,
      AccountRole.READONLY_SIGNER,
    ]);
    const url = new URL(s.calls[0]?.url ?? "");
    expect(url.pathname).toBe("/swap/v1/quote");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      inputMint: IN,
      outputMint: OUT,
      amount: "1000",
      slippageBps: "30",
      maxAccounts: "40",
      onlyDirectRoutes: "false",
    });
    expect(s.calls[1]?.url).toBe("https://quote.example/swap/v1/swap-instructions");
    expect(s.calls[1]?.init?.method).toBe("POST");
    expect(JSON.parse(s.calls[1]?.init?.body ?? "{}")).toEqual({
      quoteResponse: quote,
      userPublicKey: TAKER,
      wrapAndUnwrapSol: false,
      dynamicComputeUnitLimit: false,
    });
  });

  it("reads a route without setup or cleanup and a read-only signer", async () => {
    const s = server([
      { status: 200, body: quote },
      {
        status: 200,
        body: { setupInstructions: [], swapInstruction: ix("", false, false), cleanupInstruction: null, addressLookupTableAddresses: [] },
      },
    ]);
    const q = await pricer(s.fetch).quote({ inputMint: IN, outputMint: OUT, amountIn: 1000n, taker: TAKER });
    expect(q?.instructions).toHaveLength(1);
    expect(q?.instructions[0]?.accounts?.[0]?.role).toBe(AccountRole.READONLY);
    expect(q?.lookupTables).toEqual([]);
  });

  it("reads a route whose reply leaves out the setup and cleanup fields entirely", async () => {
    const s = server([
      { status: 200, body: quote },
      { status: 200, body: { swapInstruction: ix("", false, false), addressLookupTableAddresses: [] } },
    ]);
    const q = await pricer(s.fetch).quote({ inputMint: IN, outputMint: OUT, amountIn: 1000n, taker: TAKER });
    expect(q?.instructions).toHaveLength(1);
    expect(q?.lookupTables).toEqual([]);
  });

  it("signs only the aggregator's swap program and token account creation, never anything else it returns", async () => {
    expect([...SETUP_PROGRAMS]).toEqual([ATA]);
    expect(JUPITER_PROGRAM).toBe(PROGRAM);
    const run = (body: unknown, swapPrograms?: ReadonlySet<Address>) =>
      jupiterPricer({
        baseUrl: "https://quote.example",
        fetch: server([
          { status: 200, body: quote },
          { status: 200, body },
        ]).fetch,
        slippageBps: 30,
        maxAccounts: 40,
        ...(swapPrograms === undefined ? {} : { swapPrograms }),
      }).quote({ inputMint: IN, outputMint: OUT, amountIn: 1000n, taker: TAKER });
    const drain = ix("Ag==", true, true, SYSTEM);
    await expect(run({ ...built, setupInstructions: [drain] })).rejects.toThrow(
      `jupiter setup calls ${SYSTEM}, which this solver does not sign for`,
    );
    await expect(run({ ...built, swapInstruction: drain })).rejects.toThrow(
      `jupiter swap calls ${SYSTEM}, which this solver does not sign for`,
    );
    await expect(run({ ...built, cleanupInstruction: ix("Aw==", true, true, PROGRAM) })).rejects.toThrow(
      `jupiter cleanup calls ${PROGRAM}, which this solver does not sign for`,
    );
    await expect(run({ ...built, swapInstruction: ix("Ag==", true, false, ATA) }, new Set([ATA]))).resolves.not.toBeNull();
    const stranger = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" as Address;
    for (const [name, body] of [
      ["setup", { ...built, setupInstructions: [opens("AQ==", true, true, TAKER, stranger)] }],
      ["setup", { ...built, setupInstructions: [opens("AQ==", true, true, stranger, TAKER)] }],
      ["setup", { ...built, setupInstructions: [opens("Ag==", true, true)] }],
      ["setup", { ...built, setupInstructions: [opens("AQA=", true, true)] }],
      ["setup", { ...built, setupInstructions: [ix("AQ==", true, true, ATA)] }],
      ["cleanup", { ...built, cleanupInstruction: opens("Aw==", false, true) }],
    ] as const) {
      await expect(run(body)).rejects.toThrow(`jupiter ${name} does more than open this solver's own token account for the traded mints`);
    }
    await expect(run({ ...built, setupInstructions: [opens("AA==", true, true)] })).resolves.not.toBeNull();
    const foreignMint = { ...opens("AQ==", true, true), accounts: opens("AQ==", true, true).accounts.map((a, i) => (i === 3 ? { ...a, pubkey: stranger } : a)) };
    await expect(run({ ...built, setupInstructions: [foreignMint] })).rejects.toThrow(
      "jupiter setup does more than open this solver's own token account for the traded mints",
    );
    const inputSide = { ...opens("AQ==", true, true), accounts: opens("AQ==", true, true).accounts.map((a, i) => (i === 3 ? { ...a, pubkey: IN } : a)) };
    await expect(run({ ...built, setupInstructions: [inputSide, opens("AQ==", true, true)] })).resolves.not.toBeNull();
    await expect(run({ ...built, setupInstructions: [opens("AQ==", true, true), opens("AA==", true, true)] })).rejects.toThrow(
      "jupiter setup opens the same token account more than once",
    );
    expect([ATA_CREATE, ATA_CREATE_IDEMPOTENT]).toEqual([0, 1]);
    await expect(run(built, new Set([ATA]))).rejects.toThrow(`jupiter swap calls ${PROGRAM}`);
  });

  it("asks for the account budget a request names instead of its default", async () => {
    const s = server([
      { status: 200, body: quote },
      { status: 200, body: built },
    ]);
    await pricer(s.fetch).quote({ inputMint: IN, outputMint: OUT, amountIn: 1000n, taker: TAKER, maxAccounts: 20 });
    expect(new URL(s.calls[0]?.url ?? "").searchParams.get("maxAccounts")).toBe("20");
  });

  it("sends the api key on both calls only when it has one", async () => {
    const keyed = server([
      { status: 200, body: quote },
      { status: 200, body: built },
    ]);
    await jupiterPricer({ baseUrl: "https://quote.example", fetch: keyed.fetch, slippageBps: 30, maxAccounts: 40, apiKey: "k-1" }).quote({
      inputMint: IN,
      outputMint: OUT,
      amountIn: 1000n,
      taker: TAKER,
    });
    expect(keyed.calls.map((c) => c.init?.headers?.["x-api-key"])).toEqual(["k-1", "k-1"]);
    expect(keyed.calls[1]?.init?.headers?.["content-type"]).toBe("application/json");
    const open = server([
      { status: 200, body: quote },
      { status: 200, body: built },
    ]);
    await pricer(open.fetch).quote({ inputMint: IN, outputMint: OUT, amountIn: 1000n, taker: TAKER });
    expect(open.calls.map((c) => c.init?.headers?.["x-api-key"])).toEqual([undefined, undefined]);
  });

  it("tells the solver when the aggregator rate limits it, on either call", async () => {
    expect(RATE_LIMITED).toBe(429);
    const run = (replies: { status: number; body: unknown }[]) =>
      pricer(server(replies).fetch).quote({ inputMint: IN, outputMint: OUT, amountIn: 1000n, taker: TAKER });
    await expect(run([{ status: 429, body: {} }])).rejects.toBeInstanceOf(RateLimited);
    await expect(run([{ status: 200, body: quote }, { status: 429, body: {} }])).rejects.toThrow(
      "the aggregator is rate limiting this solver; try again on the next run",
    );
  });

  it("returns no route when the aggregator finds none", async () => {
    for (const status of [400, 404]) {
      const s = server([{ status, body: {} }]);
      await expect(
        pricer(s.fetch).quote({ inputMint: IN, outputMint: OUT, amountIn: 1000n, taker: TAKER }),
      ).resolves.toBeNull();
      expect(s.calls).toHaveLength(1);
    }
  });

  it("refuses failures, a different input amount and malformed replies", async () => {
    const run = (replies: { status: number; body: unknown }[]) =>
      pricer(server(replies).fetch).quote({ inputMint: IN, outputMint: OUT, amountIn: 1000n, taker: TAKER });
    await expect(run([{ status: 500, body: {} }])).rejects.toThrow("jupiter quote failed with status 500");
    await expect(run([{ status: 200, body: quote }, { status: 502, body: {} }])).rejects.toThrow(
      "jupiter swap-instructions failed with status 502",
    );
    await expect(run([{ status: 200, body: { ...quote, inAmount: "999" } }])).rejects.toThrow(
      "jupiter quoted a different input amount than requested",
    );
    await expect(run([{ status: 200, body: { ...quote, otherAmountThreshold: "-1" } }, { status: 200, body: built }])).rejects.toThrow(
      "jupiter response field otherAmountThreshold is not an amount: -1",
    );
    await expect(run([{ status: 200, body: { outAmount: "1" } }])).rejects.toThrow("jupiter response is missing inAmount");
    await expect(run([{ status: 200, body: { ...quote, inAmount: 1000 } }])).rejects.toThrow(
      "jupiter response field inAmount is not a string",
    );
    await expect(run([{ status: 200, body: quote }, { status: 200, body: { ...built, addressLookupTableAddresses: "x" } }])).rejects.toThrow(
      "jupiter lookup tables are not a list",
    );
    await expect(run([{ status: 200, body: quote }, { status: 200, body: { ...built, addressLookupTableAddresses: [7] } }])).rejects.toThrow(
      "jupiter lookup table is not an address",
    );
    await expect(
      run([{ status: 200, body: quote }, { status: 200, body: { ...built, swapInstruction: { ...ix("", true, true), accounts: "x" } } }]),
    ).rejects.toThrow("jupiter instruction accounts are not a list");
    await expect(run([{ status: 200, body: null }])).rejects.toThrow("jupiter response is missing inAmount");
  });
});
