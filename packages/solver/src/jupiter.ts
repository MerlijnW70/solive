import { AccountRole, type Address, address, getBase64Encoder, type Instruction } from "@solana/kit";
import type { Fetch, Pricer, Quote, QuoteRequest } from "./market.js";

export type JupiterOptions = {
  baseUrl: string;
  fetch: Fetch;
  slippageBps: number;
  maxAccounts: number;
  swapPrograms?: ReadonlySet<Address>;
  apiKey?: string;
};

export const RATE_LIMITED = 429;

export class RateLimited extends Error {
  constructor() {
    super("the aggregator is rate limiting this solver; try again on the next run");
    this.name = "RateLimited";
  }
}

export const JUPITER_PROGRAM = address("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
export const ASSOCIATED_TOKEN_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const SETUP_PROGRAMS: ReadonlySet<Address> = new Set([ASSOCIATED_TOKEN_PROGRAM]);

function allowed(ix: Instruction, programs: ReadonlySet<Address>, what: string): Instruction {
  if (!programs.has(ix.programAddress)) {
    throw new Error(`jupiter ${what} calls ${ix.programAddress}, which this solver does not sign for`);
  }
  return ix;
}

export const ATA_CREATE = 0;
export const ATA_CREATE_IDEMPOTENT = 1;
const ATA_PAYER = 0;
const ATA_WALLET = 2;
const ATA_MINT = 3;

function ownAccount(ix: Instruction, request: QuoteRequest, what: string): Instruction {
  const data = ix.data ?? new Uint8Array();
  const kind = data.length === 0 ? ATA_CREATE : data[0];
  const opens = data.length <= 1 && (kind === ATA_CREATE || kind === ATA_CREATE_IDEMPOTENT);
  const mint = ix.accounts?.[ATA_MINT]?.address;
  if (
    !opens ||
    ix.accounts?.[ATA_PAYER]?.address !== request.taker ||
    ix.accounts?.[ATA_WALLET]?.address !== request.taker ||
    (mint !== request.inputMint && mint !== request.outputMint)
  ) {
    throw new Error(`jupiter ${what} does more than open this solver's own token account for the traded mints`);
  }
  return ix;
}

function oncePerMint(setup: Instruction[]): Instruction[] {
  const mints = setup.map((ix) => ix.accounts?.[ATA_MINT]?.address);
  if (new Set(mints).size !== mints.length) {
    throw new Error("jupiter setup opens the same token account more than once");
  }
  return setup;
}

type Wire = Record<string, unknown>;

function field(value: unknown, name: string): unknown {
  if (value === null || typeof value !== "object" || !(name in value)) {
    throw new Error(`jupiter response is missing ${name}`);
  }
  return (value as Wire)[name];
}

function text(value: unknown, name: string): string {
  const found = field(value, name);
  if (typeof found !== "string") {
    throw new Error(`jupiter response field ${name} is not a string`);
  }
  return found;
}

function amount(value: unknown, name: string): bigint {
  const raw = text(value, name);
  if (!/^\d+$/.test(raw)) {
    throw new Error(`jupiter response field ${name} is not an amount: ${raw}`);
  }
  return BigInt(raw);
}

function instruction(value: unknown): Instruction {
  const accounts = field(value, "accounts");
  if (!Array.isArray(accounts)) {
    throw new Error("jupiter instruction accounts are not a list");
  }
  return {
    programAddress: address(text(value, "programId")),
    accounts: accounts.map((meta: unknown) => {
      const signer = field(meta, "isSigner") === true;
      const writable = field(meta, "isWritable") === true;
      const role = signer
        ? writable
          ? AccountRole.WRITABLE_SIGNER
          : AccountRole.READONLY_SIGNER
        : writable
          ? AccountRole.WRITABLE
          : AccountRole.READONLY;
      return { address: address(text(meta, "pubkey")), role };
    }),
    data: new Uint8Array(getBase64Encoder().encode(text(value, "data"))),
  };
}

function instructions(value: unknown, name: string): Instruction[] {
  if (!(value !== null && typeof value === "object" && name in value)) {
    return [];
  }
  const found = (value as Wire)[name];
  if (found === null || found === undefined) {
    return [];
  }
  return (Array.isArray(found) ? found : [found]).map(instruction);
}

async function body(response: { ok: boolean; status: number; json(): Promise<unknown> }, what: string) {
  if (response.status === RATE_LIMITED) {
    throw new RateLimited();
  }
  if (!response.ok) {
    throw new Error(`jupiter ${what} failed with status ${response.status}`);
  }
  return response.json();
}

export function jupiterPricer(options: JupiterOptions): Pricer {
  return {
    async quote(request: QuoteRequest): Promise<Quote | null> {
      const query = new URLSearchParams({
        inputMint: request.inputMint,
        outputMint: request.outputMint,
        amount: request.amountIn.toString(),
        slippageBps: String(options.slippageBps),
        maxAccounts: String(request.maxAccounts ?? options.maxAccounts),
        onlyDirectRoutes: "false",
      });
      const keyed = options.apiKey === undefined ? {} : { "x-api-key": options.apiKey };
      const quoted = await options.fetch(`${options.baseUrl}/quote?${query.toString()}`, { headers: keyed });
      if (quoted.status === 400 || quoted.status === 404) {
        return null;
      }
      const quote = await body(quoted, "quote");
      if (amount(quote, "inAmount") !== request.amountIn) {
        throw new Error("jupiter quoted a different input amount than requested");
      }
      const built = await body(
        await options.fetch(`${options.baseUrl}/swap-instructions`, {
          method: "POST",
          headers: { "content-type": "application/json", ...keyed },
          body: JSON.stringify({
            quoteResponse: quote,
            userPublicKey: request.taker,
            wrapAndUnwrapSol: false,
            dynamicComputeUnitLimit: false,
          }),
        }),
        "swap-instructions",
      );
      const tables = field(built, "addressLookupTableAddresses");
      if (!Array.isArray(tables)) {
        throw new Error("jupiter lookup tables are not a list");
      }
      return {
        amountIn: request.amountIn,
        amountOut: amount(quote, "otherAmountThreshold"),
        instructions: [
          ...oncePerMint(
            instructions(built, "setupInstructions").map((ix) => ownAccount(allowed(ix, SETUP_PROGRAMS, "setup"), request, "setup")),
          ),
          allowed(instruction(field(built, "swapInstruction")), options.swapPrograms ?? new Set([JUPITER_PROGRAM]), "swap"),
          ...instructions(built, "cleanupInstruction").map((ix) =>
            ownAccount(allowed(ix, SETUP_PROGRAMS, "cleanup"), request, "cleanup"),
          ),
        ],
        lookupTables: tables.map((t: unknown) => {
          if (typeof t !== "string") {
            throw new Error("jupiter lookup table is not an address");
          }
          return address(t) as Address;
        }),
      };
    },
  };
}
