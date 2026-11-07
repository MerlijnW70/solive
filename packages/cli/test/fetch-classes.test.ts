import { describe, expect, it } from "vitest";
import { type SpecFetch, SpecUnreadable, type Transport } from "@intent-engine/client";
import { DEVNET_GENESIS_HASH, MAX_SPEC_BYTES } from "@intent-engine/client/internal";
import { MAX_ARTIFACT_BYTES } from "../src/artifact.js";
import { DeliveryUnfit, DeliveryUnreadable, FETCH_CAPS, fetchBytes, fetchDelivery, NOT_PUBLIC } from "../src/delivery-fetch.js";
import { FETCH_FAILED } from "../src/agent/spec.js";
import { HTTP_LASTING, lastingSpecRead, SPEC_NOT_PUBLIC, statusOf, temporaryStatus } from "../src/fetch-class.js";
import { HTTP_LASTING as RPC_LASTING } from "../src/rpc-failure.js";
import { lastingSpecFailure } from "../src/fetch-failure.js";
import type { Lookup } from "../src/public-address.js";
import { walletFetchWork } from "../src/agent/wallet/work.js";
import { walletJudgeWork } from "../src/agent/wallet/judge-work.js";

const PUBLIC = { genesisHash: async () => DEVNET_GENESIS_HASH } as unknown as Transport;
const URL_OF = "https://" + "work.example.org/x";
const delivery = (url: string) => ({ announcement: { address: url, intent: url, worker: url, commitment: new Uint8Array(32) } as never, salt: "00".repeat(16), url });
const open: Lookup = async () => ["93.184.215.14"];
const inside: Lookup = async () => ["10.0.0.7"];
const answering =
  (status: number): SpecFetch =>
  async () =>
    new Response("no", { status });

describe("one rule for retrying a fetch", () => {
  it("treats 408, 425, 429 and every 5xx but 501 and 505 as temporary and other statuses as final", () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504, 506, 599]) {
      expect(temporaryStatus(status), String(status)).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 410, 451]) {
      expect(temporaryStatus(status), String(status)).toBe(false);
    }
  });

  it("treats 501 as lasting, as the RPC classifier does", () => {
    expect([temporaryStatus(501), HTTP_LASTING.has(501), lastingSpecRead({ message: "the spec at u answered 501", url: "u" }, false)]).toEqual([false, true, true]);
  });

  it("treats 505 as lasting, as the RPC classifier does", () => {
    expect([temporaryStatus(505), HTTP_LASTING.has(505), lastingSpecRead({ message: "the spec at u answered 505", url: "u" }, false)]).toEqual([false, true, true]);
  });

  it("keeps one list of lasting server errors, the one the RPC classifier reads", () => {
    expect(RPC_LASTING).toBe(HTTP_LASTING);
    expect([...HTTP_LASTING]).toEqual([501, 505]);
  });

  it("reads the typed status of a spec failure before its message", () => {
    expect(statusOf({ message: "the spec at u answered 404", status: 429 })).toBe(429);
    expect(statusOf({ message: "the spec at u answered 404", status: null })).toBe(404);
    expect(statusOf({ message: "the spec at u is not a url" })).toBeUndefined();
    expect(lastingSpecRead({ message: "the spec at u answered 404", status: 429 }, true)).toBe(false);
    expect(lastingSpecRead({ message: "the spec at u failed", status: 404 }, true)).toBe(true);
  });

  it("makes a rate-limited or timed-out spec temporary and a missing one final, by status or by message", async () => {
    for (const [status, lasting] of [
      [408, false],
      [429, false],
      [500, false],
      [404, true],
      [410, true],
    ] as const) {
      const error = new SpecUnreadable("https://a.example/s", `answered ${status}`, { status });
      expect(error.status).toBe(status);
      expect(lastingSpecRead(error, true), String(status)).toBe(lasting);
      expect(await lastingSpecFailure(error.message, open), String(status)).toBe(lasting);
    }
    expect(lastingSpecRead({ message: "the spec at u answered 429" }, true)).toBe(false);
  });

  it("keeps the same fixed refusals final and a private address final only where allowed", async () => {
    for (const reason of ["is not a url", "is not an http or https url", "is larger than 5 bytes"]) {
      expect(lastingSpecRead({ message: `the spec at u ${reason}` }, false), reason).toBe(true);
      expect(lastingSpecRead({ message: `the spec at u ${reason}`, url: "u" }, false), reason).toBe(true);
    }
    const privateSpec = "the spec at https://a.example/s " + SPEC_NOT_PUBLIC;
    expect(lastingSpecRead({ message: privateSpec }, true)).toBe(true);
    expect(lastingSpecRead({ message: privateSpec, url: "https://a.example/s" }, true)).toBe(true);
    expect(lastingSpecRead({ message: privateSpec }, false)).toBe(false);
  });

  it("calls a sealed spec that cannot be opened final only by its reason, never by a phrase inside the url", async () => {
    const real = { message: "the spec at https://a.example/s is sealed but could not be opened: bad key", url: "https://a.example/s" };
    expect(lastingSpecRead(real, true)).toBe(true);
    expect(lastingSpecRead({ message: "the spec at https://a.example/s is sealed but could not be opened", url: "https://a.example/s" }, true)).toBe(true);
    const hostile = "https://a.example/x is sealed but could not be opened";
    const temporary = `the spec at ${hostile} ${FETCH_FAILED} (fetch failed)`;
    expect(lastingSpecRead({ message: temporary, url: hostile }, true)).toBe(false);
    expect(lastingSpecRead({ message: temporary }, true)).toBe(false);
    expect(await lastingSpecFailure(temporary, open)).toBe(false);
    expect(await lastingSpecFailure(real.message, open)).toBe(false);
  });
});

describe("fetching a delivery", () => {
  it("refuses a private url as final and says why", async () => {
    const failure = await fetchDelivery(answering(200), PUBLIC, delivery("https://" + "10.0.0.7/work.txt"), 5, inside).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DeliveryUnfit);
    expect((failure as DeliveryUnfit).reason).toBe(NOT_PUBLIC);
    expect(await fetchBytes(answering(200), PUBLIC, "https://" + "10.0.0.7/work.txt", inside)).toStrictEqual({ problem: NOT_PUBLIC });
  });

  it("keeps the cause of a failed fetch in the error and in its words, as fetchBytes does", async () => {
    const cause = new Error("read ECONNRESET");
    const failing: SpecFetch = async () => {
      throw new TypeError("fetch failed", { cause });
    };
    const failure = (await fetchDelivery(failing, PUBLIC, delivery(URL_OF), 5, open).catch((error: unknown) => error)) as DeliveryUnreadable;
    expect(failure).toBeInstanceOf(DeliveryUnreadable);
    expect(failure.cause).toBeInstanceOf(TypeError);
    expect((failure.cause as TypeError).cause).toBe(cause);
    expect(failure.reason).toBe("could not be fetched (fetch failed: read ECONNRESET)");
    const found = await fetchBytes(failing, PUBLIC, URL_OF, open);
    expect(found).toStrictEqual({ problem: failure.reason, temporary: true });
  });

  it("keeps the cause of a final failure too", async () => {
    const cause = new Error("unexpected redirect");
    const redirecting: SpecFetch = async () => {
      throw new TypeError("fetch failed", { cause });
    };
    const failure = (await fetchDelivery(redirecting, PUBLIC, delivery(URL_OF), 5, open).catch((error: unknown) => error)) as DeliveryUnfit;
    expect(failure).toBeInstanceOf(DeliveryUnfit);
    expect((failure.cause as TypeError).cause).toBe(cause);
    expect(failure.reason).toBe("could not be fetched (fetch failed: unexpected redirect)");
  });

  it("retries a rate-limited or timed-out work url and drops a missing one", async () => {
    for (const [status, temporary] of [
      [429, true],
      [408, true],
      [404, false],
    ] as const) {
      const failure = await fetchDelivery(answering(status), PUBLIC, delivery(URL_OF), 5, open).catch((error: unknown) => error);
      expect(failure, String(status)).toBeInstanceOf(temporary ? DeliveryUnreadable : DeliveryUnfit);
      const found = await fetchBytes(answering(status), PUBLIC, URL_OF, open);
      expect("problem" in found && found.temporary === true, String(status)).toBe(temporary);
    }
  });
});

describe("the size caps", () => {
  it("states one cap for the watch and one for the tools, and names them in the tool texts", () => {
    expect(FETCH_CAPS).toStrictEqual({ watch: MAX_ARTIFACT_BYTES, tools: MAX_SPEC_BYTES });
    expect(walletFetchWork.description).toContain(`at most ${FETCH_CAPS.tools} bytes`);
    expect(walletFetchWork.description).toContain(`judge --watch: ${FETCH_CAPS.watch}`);
    expect(walletJudgeWork.description).toContain(`at most ${FETCH_CAPS.tools} bytes`);
  });
});
