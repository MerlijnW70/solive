import {
  type Address,
  getSolanaErrorFromJsonRpcError,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SolanaError,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  behindMinSlot,
  patiently,
  POLL_MS,
  RATE_LIMIT_ATTEMPTS,
  rateLimited,
  type RpcLike,
  rpcTransport,
} from "../src/transport.js";
import { ENGINE_ERRORS, explain } from "../src/errors.js";
import { isolateMocks, OWNER, SIG, stub } from "./transport-stub.js";

isolateMocks();

describe("rate limits", () => {
  const throttled = () => new Error("HTTP error (429): Too Many Requests");

  it("recognises only a 429 status as rate limiting", () => {
    expect(rateLimited(throttled())).toBe(true);
    expect(rateLimited(new Error("HTTP error (500): boom"))).toBe(false);
    expect(rateLimited(new Error("slot 4290 not found"))).toBe(false);
    expect(rateLimited("429")).toBe(false);
  });

  it("backs off exponentially and returns once a call succeeds", async () => {
    const waits: number[] = [];
    let calls = 0;
    const value = await patiently(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw throttled();
        }
        return "ok";
      },
      async (ms) => {
        waits.push(ms);
      },
    );
    expect(value).toBe("ok");
    expect(waits).toEqual([2 * POLL_MS, 4 * POLL_MS]);
  });

  it("gives up after the last attempt and never retries other failures", async () => {
    expect(RATE_LIMIT_ATTEMPTS).toBe(6);
    const waits: number[] = [];
    let calls = 0;
    await expect(
      patiently(
        async () => {
          calls += 1;
          throw throttled();
        },
        async (ms) => {
          waits.push(ms);
        },
      ),
    ).rejects.toThrow("429");
    expect(calls).toBe(RATE_LIMIT_ATTEMPTS);
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000]);
    let other = 0;
    await expect(
      patiently(async () => {
        other += 1;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(other).toBe(1);
  });

  it("rides out a throttled read inside the transport", async () => {
    const s = stub([]);
    let first = true;
    const rpc = {
      ...s.rpc,
      getAccountInfo: (address: Address) => ({
        send: async () => {
          if (first) {
            first = false;
            throw throttled();
          }
          return s.rpc.getAccountInfo(address).send();
        },
      }),
    } satisfies RpcLike;
    const t = rpcTransport(rpc, s.wait);
    expect(await t.getAccount(OWNER)).toEqual({ owner: OWNER, data: new Uint8Array([1, 2, 3]), lamports: 7n, executable: true });
    expect(s.waits).toEqual([2 * POLL_MS]);
  });
});

describe("airdrops", () => {
  it("airdrop retries when rate limited", async () => {
    const s = stub([{ err: null, confirmationStatus: "confirmed" }]);
    let refusals = 2;
    const rpc = {
      ...s.rpc,
      requestAirdrop: (address: Address, lamports: bigint) => ({
        send: async () => {
          if (refusals > 0) {
            refusals -= 1;
            throw new Error("HTTP error (429): Too Many Requests");
          }
          return s.rpc.requestAirdrop(address, lamports).send();
        },
      }),
    } satisfies RpcLike;
    expect(await rpcTransport(rpc, s.wait).airdrop(OWNER, 5n)).toBe(SIG);
    expect(refusals).toBe(0);
    expect(s.waits).toEqual([2 * POLL_MS, 4 * POLL_MS]);
    expect(s.calls.filter((c) => c.startsWith("airdrop:"))).toEqual([`airdrop:${OWNER}:5`]);
  });
});

describe("rpc errors read by code", () => {
  function production<T>(make: () => T): T {
    const before = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      return make();
    } finally {
      if (before === undefined) {
        delete process.env["NODE_ENV"];
      } else {
        process.env["NODE_ENV"] = before;
      }
    }
  }

  const httpError = (statusCode: number) =>
    production(() => new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message: "Too Many Requests", statusCode }));

  const behindError = () =>
    production(() => getSolanaErrorFromJsonRpcError({ code: -32016, message: "Minimum context slot has not been reached", data: { contextSlot: 5 } }));

  it("a rate limit is recognised with production error messages", async () => {
    const throttled = httpError(429);
    expect(throttled.message).toMatch(/^Solana error #8100002/);
    expect(throttled.message).not.toMatch(/\b429\b|Too Many Requests/);
    expect(rateLimited(throttled)).toBe(true);
    expect(rateLimited(new Error("the read failed", { cause: throttled }))).toBe(true);
    expect(rateLimited(httpError(500))).toBe(false);
    expect(rateLimited(new Error("HTTP error (429): Too Many Requests", { cause: httpError(503) }))).toBe(false);
    const waits: number[] = [];
    let calls = 0;
    const value = await patiently(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw httpError(429);
        }
        return "ok";
      },
      async (ms) => {
        waits.push(ms);
      },
    );
    expect(value).toBe("ok");
    expect(waits).toEqual([2 * POLL_MS, 4 * POLL_MS]);
  });

  it("a minimum context slot error is recognised with production error messages", async () => {
    const behind = behindError();
    expect(behind.message).toMatch(/^Solana error #-32016/);
    expect(behind.message).not.toMatch(/minimum context slot/i);
    expect(behindMinSlot(behind)).toBe(true);
    expect(behindMinSlot(new Error("the read failed", { cause: behind }))).toBe(true);
    const skipped = production(() => getSolanaErrorFromJsonRpcError({ code: -32007, message: "Slot 5 was skipped", data: {} }));
    expect(behindMinSlot(skipped)).toBe(false);
    expect(rateLimited(skipped)).toBe(false);
    const waits: number[] = [];
    let calls = 0;
    await patiently(
      async () => {
        calls += 1;
        if (calls < 2) {
          throw behindError();
        }
      },
      async (ms) => {
        waits.push(ms);
      },
    );
    expect(waits).toEqual([2 * POLL_MS]);
  });

  it("every rpc error that decides behaviour is read by its code before its text", () => {
    const [code] = [...ENGINE_ERRORS.keys()];
    const failed = production(() =>
      getSolanaErrorFromJsonRpcError({
        code: -32002,
        message: "Transaction simulation failed",
        data: { accounts: null, logs: [], unitsConsumed: 0, returnData: null, err: { InstructionError: [0, { Custom: code }] } },
      }),
    );
    expect(failed.message).not.toMatch(/custom program error/i);
    const decided: [string, boolean][] = [
      ["rateLimited", rateLimited(httpError(429))],
      ["behindMinSlot", behindMinSlot(behindError())],
      ["explain", code !== undefined && explain(failed)?.code === code],
    ];
    expect(decided).toEqual([
      ["rateLimited", true],
      ["behindMinSlot", true],
      ["explain", true],
    ]);
  });
});
