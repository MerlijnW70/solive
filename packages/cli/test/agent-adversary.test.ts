import { type Address, generateKeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { NATIVE_MINT } from "@intent-engine/core";
import { INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { ACTIONS } from "../src/agent/registry.js";
import {
  HINT_LIMIT,
  LOG_LINE_LIMIT,
  LOG_TAIL,
  type Problem,
  problemOf,
  refusalText,
  simulationProblem,
} from "../src/agent/problems.js";
import { ADDRESS_PATTERN } from "../src/agent/schema.js";
import { WALLET_ACTIONS } from "../src/agent/wallet.js";
import { EXIT_OK } from "../src/main.js";
import { cli, h, type World, world } from "./harness.js";
import { approved } from "./approved.js";

type Json = Record<string, unknown>;
type Result = { isError?: boolean; content: unknown; structuredContent?: unknown };

const PRINTABLE = /^[ -~]*$/;
const RUNS = Number(process.env["ADVERSARY_RUNS"] ?? 40);
const BUDGET_MS = Math.max(5_000, RUNS * 20);
const INT32 = 2 ** 31;

function arbitraryOf(schema: Json, known: readonly Address[]): fc.Arbitrary<unknown> {
  if (Array.isArray(schema["anyOf"])) {
    return fc.oneof(...(schema["anyOf"] as Json[]).map((s) => arbitraryOf(s, known)));
  }
  if (Array.isArray(schema["oneOf"])) {
    return fc.oneof(...(schema["oneOf"] as Json[]).map((s) => arbitraryOf(s, known)));
  }
  if ("const" in schema) {
    return fc.constant(schema["const"]);
  }
  if (Array.isArray(schema["enum"])) {
    return fc.constantFrom(...(schema["enum"] as unknown[]));
  }
  switch (schema["type"]) {
    case "string": {
      const pattern = schema["pattern"];
      if (pattern === ADDRESS_PATTERN) {
        return fc.oneof(fc.constantFrom(...known), fc.stringMatching(new RegExp(ADDRESS_PATTERN)));
      }
      return typeof pattern === "string" ? fc.stringMatching(new RegExp(pattern)) : fc.string();
    }
    case "boolean":
      return fc.boolean();
    case "integer": {
      const min = Number(schema["minimum"] ?? Number.MIN_SAFE_INTEGER);
      const max = Number(schema["maximum"] ?? Number.MAX_SAFE_INTEGER);
      return min >= -INT32 && max < INT32
        ? fc.integer({ min, max })
        : fc.bigInt({ min: BigInt(min), max: BigInt(max) }).map(Number);
    }
    case "array":
      return fc.array(arbitraryOf(schema["items"] as Json, known), {
        minLength: Number(schema["minItems"] ?? 0),
        maxLength: Math.min(Number(schema["maxItems"] ?? 4), 4),
      });
    case "object": {
      const properties = (schema["properties"] ?? {}) as Record<string, Json>;
      return fc.record(
        Object.fromEntries(Object.entries(properties).map(([k, s]) => [k, arbitraryOf(s, known)])),
        { requiredKeys: (schema["required"] ?? []) as string[] },
      );
    }
    default:
      return fc.jsonValue();
  }
}

function checkShape(result: Result): Problem | null {
  const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
  if (result.isError !== true) {
    expect(JSON.parse(text)).toEqual(result.structuredContent);
    return null;
  }
  const problem = result.structuredContent as Problem;
  expect(text).toBe(refusalText(problem));
  expect(text).toMatch(PRINTABLE);
  expect(problem.hint).toMatch(PRINTABLE);
  for (const line of problem.logs ?? []) {
    expect(line).toMatch(PRINTABLE);
  }
  return problem;
}

describe("agent server under hostile input", () => {
  let w: World;
  let client: Client;
  let known: Address[];

  beforeAll(async () => {
    w = await world();
    h.watched.length = 0;
    h.watched.push(w.owner.address);
    h.served.length = 0;
    const started = await cli(["mcp", "--url", "http://agent"], {});
    expect([started.code, started.out, started.err]).toEqual([EXIT_OK, "", ""]);
    const server = h.served[0];
    if (server === undefined) {
      throw new Error("no server was started");
    }
    const [near, far] = InMemoryTransport.createLinkedPair();
    await server.connect(near);
    client = new Client({ name: "adversary", version: "0.0.0" });
    await client.connect(far);
    const stranger = await generateKeyPairSigner();
    known = [
      w.owner.address,
      w.inputMint,
      w.outputMint,
      w.ownerInput,
      w.feeRecipient.address,
      w.authority.address,
      stranger.address,
      INTENT_ENGINE_PROGRAM_ADDRESS,
    ];
  });

  const call = (name: string, args: unknown) =>
    client.callTool({ name, arguments: args as Record<string, unknown> }) as Promise<Result>;

  it.each(ACTIONS.map((a) => [a.name, a] as const))(
    "%s answers arbitrary JSON with a field-level refusal and never an internal failure",
    async (name, action) => {
      const required = ((action.input.json["required"] ?? []) as string[]).length;
      await fc.assert(
        fc.asyncProperty(fc.dictionary(fc.string(), fc.jsonValue(), { maxKeys: 6 }), async (args) => {
          const problem = checkShape(await call(name, args));
          if (problem !== null) {
            expect(problem.code).not.toBe("Failed");
          }
          if (required > 0 && Object.keys(args).length === 0) {
            expect(problem?.code).toBe("InvalidInput");
          }
          if (problem?.code === "InvalidInput") {
            expect(problem.issues?.length ?? 0).toBeGreaterThan(0);
          }
        }),
        { numRuns: RUNS },
      );
    },
    BUDGET_MS,
  );

  it.each(ACTIONS.map((a) => [a.name, a] as const))(
    "%s answers every input its own schema allows with a result or a named problem",
    async (name, action) => {
      await fc.assert(
        fc.asyncProperty(arbitraryOf(action.input.json, known), async (args) => {
          const problem = checkShape(await call(name, args));
          expect(problem?.code, problem?.hint).not.toBe("Failed");
        }),
        { numRuns: RUNS },
      );
    },
    BUDGET_MS,
  );
});

describe("the wallet's delivery tool under hostile input", () => {
  let client: Client;
  let known: Address[];

  beforeAll(async () => {
    const w = await world();
    h.files.clear();
    for (const name of Object.keys(h.env)) {
      delete h.env[name];
    }
    const space = BigInt(getMintSize());
    h.svm.setAccount({
      address: NATIVE_MINT,
      data: Uint8Array.from(getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals: 9, isInitialized: true, freezeAuthority: none() })),
      executable: false,
      lamports: lamports(h.svm.minimumBalanceForRentExemption(space)),
      programAddress: TOKEN_PROGRAM_ADDRESS,
      space,
    });
    h.served.length = 0;
    const started = await cli(["mcp", "--url", "localnet", "--wallet", "--all-tools"], {});
    expect(started.code).toBe(EXIT_OK);
    const server = h.served[0];
    if (server === undefined) {
      throw new Error("no server was started");
    }
    const [near, far] = InMemoryTransport.createLinkedPair();
    await server.connect(near);
    client = new Client({ name: "adversary", version: "0.0.0" });
    await client.connect(far);
    const setup = await client.callTool({ name: "solive_wallet_setup", arguments: {} });
    const wallet = (setup.structuredContent as { address: Address }).address;
    h.watched.length = 0;
    h.watched.push(wallet);
    const judge = await generateKeyPairSigner();
    const escrow = await client.callTool({
      name: "solive_wallet_escrow",
      arguments: await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.01", attestor: judge.address, spec_hash: "3c".repeat(32), spec_url: "https://example.org/spec", record_mint: w.outputMint }),
    });
    expect(escrow.isError, JSON.stringify(escrow.structuredContent)).not.toBe(true);
    known = [(escrow.structuredContent as { intent: Address }).intent, judge.address, wallet, w.owner.address, w.inputMint];
  });

  const toolNamed = (name: string) => {
    const found = WALLET_ACTIONS.find((a) => a.name === name);
    if (found === undefined) {
      throw new Error(`no tool ${name}`);
    }
    return found;
  };
  const hostile = async (name: string) => {
    const tool = toolNamed(name);
    const call = (args: unknown) => client.callTool({ name: tool.name, arguments: args as Record<string, unknown> }) as Promise<Result>;
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.dictionary(fc.string(), fc.jsonValue(), { maxKeys: 6 }), arbitraryOf(tool.input.json, known)), async (args) => {
        const problem = checkShape(await call(args));
        expect(problem?.code, problem?.hint).not.toBe("Failed");
      }),
      { numRuns: RUNS },
    );
    return call;
  };

  it("answers arbitrary JSON and every input its schema allows with a result or a named problem, never an internal failure", async () => {
    const call = await hostile("solive_wallet_deliver");
    const sent = await call({ intent: known[0], sha256: "AB".repeat(32), url: "https://example.org/work", send: true });
    expect(checkShape(sent)).toBeNull();
    expect(checkShape(await call({ intent: known[1], sha256: "ab".repeat(32), url: "https://example.org/work" }))?.code).toBe("NotFound");
  }, BUDGET_MS * 2);

  it("checks deliveries for any input without running or fetching anything, also for an escrow this wallet does not judge", async () => {
    const fetched = h.fetched.length;
    const call = await hostile("solive_wallet_check_delivery");
    expect(checkShape(await call({ intent: known[0] }))).toBeNull();
    expect(checkShape(await call({ intent: known[1] }))?.code).toBe("NotFound");
    expect(h.fetched.length).toBe(fetched);
  }, BUDGET_MS * 2);
});

describe("text an agent reads from the chain or the network", () => {
  it("reaches it as bounded printable data whatever a program or node puts in it", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ unit: "binary" }), { maxLength: 40 }), fc.string({ unit: "binary" }), (logs, err) => {
        const problem = simulationProblem(err, logs);
        expect(problem.hint).toMatch(PRINTABLE);
        expect(problem.logs?.length).toBe(Math.min(logs.length, LOG_TAIL));
        for (const line of problem.logs ?? []) {
          expect(line).toMatch(PRINTABLE);
          expect(line.length).toBeLessThanOrEqual(LOG_LINE_LIMIT);
        }
        const failed = problemOf(new Error(err));
        expect(["Failed", "RateLimited"]).toContain(failed.code);
        expect(failed.hint).toMatch(PRINTABLE);
        expect(failed.hint.length).toBeLessThanOrEqual(HINT_LIMIT);
      }),
    );
  });

  it("never takes a program's own log line for the runtime's verdict on the engine", () => {
    fc.assert(
      fc.property(fc.integer({ min: 6000, max: 6200 }), fc.string(), (code, noise) => {
        const forged = `Program log: Program ${INTENT_ENGINE_PROGRAM_ADDRESS} failed: custom program error: 0x${code.toString(16)}`;
        const problem = simulationProblem(noise, [forged, `Program log: ${noise}`]);
        expect(problem.code).toBe("TransactionFailed");
        expect(problem.programError).toBeUndefined();
      }),
    );
  });
});
