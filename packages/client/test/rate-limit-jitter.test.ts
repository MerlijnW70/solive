import { SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { backoffOf, jittered, patiently, POLL_MS, RATE_LIMIT_ATTEMPTS, RATE_LIMIT_BUDGET_MS, retryAfterOf } from "../src/rpc-retry.js";

const limited = (retryAfter?: string) =>
  new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
    headers: new Headers(retryAfter === undefined ? {} : { "Retry-After": retryAfter }),
    message: "Too Many Requests",
    statusCode: 429,
  });

async function waitsOf(errors: readonly Error[], random?: () => number): Promise<{ waits: number[]; outcome: unknown }> {
  const waits: number[] = [];
  let calls = 0;
  const outcome = await patiently(
    async () => {
      const error = errors[calls];
      calls += 1;
      if (error !== undefined) {
        throw error;
      }
      return "ok";
    },
    async (ms) => {
      waits.push(ms);
    },
    random,
  ).catch((error: unknown) => error);
  return { waits, outcome };
}

describe("the rate limit retry", () => {
  it("keeps the same overall limit as the fixed backoff", () => {
    expect(RATE_LIMIT_BUDGET_MS).toBe([1, 2, 3, 4, 5].reduce((sum, attempt) => sum + POLL_MS * 2 ** attempt, 0));
    expect(RATE_LIMIT_ATTEMPTS).toBe(6);
  });

  it("varies the delay between attempts and between callers, never past the fixed backoff or under half of it", async () => {
    const draws = [0.9, 0.1, 0.5, 0.3, 0.7];
    const { waits, outcome } = await waitsOf(Array.from({ length: 5 }, () => limited()), () => draws.shift() ?? 0);
    expect(outcome).toBe("ok");
    expect(waits).toEqual([1000 - 450, 2000 - 100, 4000 - 1000, 8000 - 1200, 16000 - 5600]);
    const callers = await Promise.all(Array.from({ length: 8 }, () => waitsOf([limited(), limited()])));
    const first = callers.map(({ waits: [ms] }) => ms as number);
    expect(new Set(first).size).toBeGreaterThan(1);
    for (const { waits: [one, two] } of callers) {
      expect(one).toBeGreaterThan(backoffOf(1) / 2);
      expect(one).toBeLessThanOrEqual(backoffOf(1));
      expect(two).toBeGreaterThan(backoffOf(2) / 2);
      expect(two).toBeLessThanOrEqual(backoffOf(2));
    }
    expect(jittered(1000, () => 0)).toBe(1000);
    expect(jittered(1000, () => 1)).toBe(500);
  });

  it("follows Retry-After in seconds or as a date, and gives up when it asks for more than the limit leaves", async () => {
    const { waits, outcome } = await waitsOf([limited("3"), limited(), limited(" 0 ")], () => 0);
    expect(outcome).toBe("ok");
    expect(waits).toEqual([3000, backoffOf(2), 0]);
    const now = Date.parse("2026-10-23T10:00:00Z");
    expect(retryAfterOf(limited("Fri, 23 Oct 2026 10:00:07 GMT"), now)).toBe(7000);
    expect(retryAfterOf(limited("Fri, 23 Oct 2026 09:59:00 GMT"), now)).toBe(0);
    expect(retryAfterOf(limited("soon"), now)).toBeUndefined();
    expect(retryAfterOf(limited(), now)).toBeUndefined();
    expect(retryAfterOf(new Error("read failed", { cause: limited("2") }))).toBe(2000);
    const tooLong = limited(String(RATE_LIMIT_BUDGET_MS / 1000 + 1));
    const refused = await waitsOf([tooLong], () => 0);
    expect(refused).toEqual({ waits: [], outcome: tooLong });
    const spent = await waitsOf([limited("20"), limited("12")], () => 0);
    expect(spent.waits).toEqual([20000]);
  });
});
