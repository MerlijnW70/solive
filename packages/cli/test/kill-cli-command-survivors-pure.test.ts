import { generateKeyPairSigner, type Address } from "@solana/kit";
import { claimantChunks } from "@intent-engine/core/internal";
import type { ClaimListView, Transport } from "@intent-engine/client";
import { describe, expect, it } from "vitest";
import { handedTo } from "../src/claim-commands.js";
import { finishList, limitsLine, openListed } from "../src/claim-lists.js";
import { sharesHeld } from "../src/crank.js";
import { signatureLookup } from "../src/flow-commands.js";
import { capChanges, floorChanges, isMintCaps } from "../src/monitor-limits.js";
import { httpRefused, npmRegistry, plainRegistry } from "../src/npm-registry.js";
import { rpcCause, rpcFailed } from "../src/rpc-failure.js";
import { wtf8Decode, wtf8Encode } from "../src/wtf8.js";

const ADDRESS = "11111111111111111111111111111112" as Address;

describe("wtf8 survivors", () => {
  it("decodes astral characters to the exact surrogate pair", () => {
    expect(wtf8Decode(Uint8Array.from([0xf0, 0x90, 0x80, 0x80]))).toBe("\u{10000}");
    expect(wtf8Decode(Uint8Array.from([0xf4, 0x8f, 0xbf, 0xbf]))).toBe("\u{10ffff}");
    expect(wtf8Decode(Uint8Array.from(Buffer.from("a\u{1f600}b")))).toBe("a\u{1f600}b");
    const pair = wtf8Decode(Uint8Array.from([0xf0, 0x9f, 0x98, 0x80]));
    expect([pair.charCodeAt(0), pair.charCodeAt(1)]).toStrictEqual([0xd83d, 0xde00]);
  });

  it("accepts a lone low surrogate triple after a non-surrogate character", () => {
    expect(wtf8Decode(Uint8Array.from([0xc3, 0xa9, 0xed, 0xb0, 0x80]))).toBe("é\udc00");
    expect(wtf8Decode(Uint8Array.from([0xe0, 0xa0, 0x80, 0xed, 0xb0, 0x80]))).toBe("ࠀ\udc00");
  });

  it("encodes each width at its exact boundary", () => {
    expect([...wtf8Encode("\u007f")]).toStrictEqual([0x7f]);
    expect([...wtf8Encode("\u0080")]).toStrictEqual([0xc2, 0x80]);
    expect([...wtf8Encode("߿")]).toStrictEqual([0xdf, 0xbf]);
    expect([...wtf8Encode("ࠀ")]).toStrictEqual([0xe0, 0xa0, 0x80]);
    expect([...wtf8Encode("￿")]).toStrictEqual([0xef, 0xbf, 0xbf]);
    expect([...wtf8Encode("\u{10000}")]).toStrictEqual([0xf0, 0x90, 0x80, 0x80]);
  });
});

describe("rpc failure survivors", () => {
  const coded = (code: string, cause?: unknown) => Object.assign(new Error("link", { cause }), { code });
  const json = (code: number) => Object.assign(new Error("rpc"), { name: "SolanaError", context: { __code: code } });

  it("follows exactly the first eight links of a cause chain", () => {
    let chain: Error = coded("ECONNREFUSED");
    for (let i = 0; i < 7; i++) {
      chain = new Error("wrap", { cause: chain });
    }
    expect(rpcCause(chain)).toStrictEqual({ kind: "unreached" });
    expect(rpcFailed(new Error("wrap", { cause: chain }))).toBe(false);
  });

  it("treats both ends of the json-rpc range as json-rpc failures", () => {
    expect(rpcCause(json(-32_000))).toStrictEqual({ kind: "json-rpc" });
    expect(rpcCause(json(-32_768))).toStrictEqual({ kind: "json-rpc" });
    expect(rpcCause(json(-31_999))).toBeNull();
    expect(rpcCause(json(-32_769))).toBeNull();
  });
});

describe("monitor limits survivors", () => {
  it("lists changed mints in sorted order whatever order they arrive in", () => {
    const shuffled = { m: "1", c: "1", z: "1", a: "1", q: "1", b: "1" };
    expect(floorChanges(shuffled, {}).map((change) => change.mint)).toStrictEqual(["a", "b", "c", "m", "q", "z"]);
    const reversed = { z: "1", y: "1", x: "1", w: "1", v: "1" };
    expect(floorChanges({}, reversed).map((change) => change.mint)).toStrictEqual(["v", "w", "x", "y", "z"]);
    const many = Array.from({ length: 300 }, (_, i) => "k" + ((i * 7919) % 1009).toString(36) + i);
    expect(floorChanges(Object.fromEntries(many.map((mint) => [mint, "1"])), {}).map((change) => change.mint)).toStrictEqual([...many].sort());
    const cap = { maxPerOrder: "1", windowCap: "1", windowSecs: 1, totalLimit: "1" };
    expect(capChanges({ c: cap, a: cap, b: cap }, {}, "none").map((change) => change.mint)).toStrictEqual(["a", "a", "a", "a", "b", "b", "b", "b", "c", "c", "c", "c"]);
  });

  it("accepts only decimal strings for the raw cap limits", () => {
    const mint = "So11111111111111111111111111111111111111112";
    const good = { maxPerOrder: "1", windowCap: "2", windowSecs: 3, totalLimit: "4" };
    expect(isMintCaps({ [mint]: good })).toBe(true);
    expect(isMintCaps({ [mint]: { ...good, maxPerOrder: 5 } })).toBe(false);
    expect(isMintCaps({ [mint]: { ...good, totalLimit: 7 } })).toBe(false);
    expect(isMintCaps({ [mint]: { ...good, windowCap: "abc" } })).toBe(false);
    expect(isMintCaps({ [mint]: { ...good, windowSecs: "3" } })).toBe(false);
  });
});

describe("npm registry survivors", () => {
  it("names the package scope in the plain-http warning for each key", () => {
    expect(plainRegistry("http://r.example", "registry")).toMatch(/^npm fetches packages from http:\/\/r\.example over plain http,/);
    expect(plainRegistry("http://r.example", "@intent-engine:registry")).toMatch(/^npm fetches @intent-engine packages from http:\/\/r\.example over plain http,/);
    expect(httpRefused("http://r.example", "@intent-engine:registry")).toContain("@intent-engine packages");
  });

  it("keeps a failure reason of the exact limit whole and clips one character more", async () => {
    const failing = (text: string) => async () => {
      throw new Error(text);
    };
    const whole = "x".repeat(200);
    expect(await npmRegistry(failing(whole))).toStrictEqual({ read: "failed", reason: whole });
    expect(await npmRegistry(failing(whole + "y"))).toStrictEqual({ read: "failed", reason: whole + "..." });
  });
});

describe("crank survivors", () => {
  it("writes the claim deadline as the date its seconds name", () => {
    expect(sharesHeld(ADDRESS, 86_400n)).toContain("or 1970-01-02T00:00:00.000Z, a year after it expired");
  });
});

describe("claim list survivors", () => {
  const sent: string[] = [];
  const transport = {
    send: async () => {
      sent.push("sig" + sent.length);
      return "sig" + (sent.length - 1);
    },
  } as unknown as Transport;

  it("says one listed wallet in the singular and more in the plural", () => {
    expect(limitsLine([ADDRESS])).toBe("Limits: claims to the 1 listed wallet " + ADDRESS + "; the program refuses any other");
    expect(limitsLine([ADDRESS, ADDRESS])).toBe("Limits: claims to the 2 listed wallets " + ADDRESS + ", " + ADDRESS + "; the program refuses any other");
  });

  it("opens a single-part list without a parts line and reports it sent", async () => {
    sent.length = 0;
    const owner = await generateKeyPairSigner();
    const done = (await openListed({ maxSecs: 60, stake: 0n, workers: [ADDRESS], yes: true }, owner, transport, ADDRESS, ADDRESS, "Opens: it")) as {
      summary: string[];
      sent: boolean;
      signature: string;
      signatures: string[];
    };
    expect(done.summary.some((line) => line.startsWith("Sends:"))).toBe(false);
    expect([done.sent, done.signature, done.signatures]).toStrictEqual([true, "sig0", ["sig0"]]);
  });

  it("finishes a list in parts and reports each part", async () => {
    sent.length = 0;
    const owner = await generateKeyPairSigner();
    const workers = await Promise.all(Array.from({ length: 32 }, async () => (await generateKeyPairSigner()).address));
    const list: ClaimListView = { address: ADDRESS, size: 32, workers: workers.slice(0, 1), complete: false } as ClaimListView;
    const parts = claimantChunks(workers.slice(1)).length;
    const done = (await finishList(workers, owner, transport, ADDRESS, list, true)) as { summary: string[]; sent: boolean; signatures: string[] };
    expect(done.sent).toBe(true);
    expect(done.signatures).toHaveLength(parts);
    expect(done.summary.filter((line) => line.startsWith("Sends:"))).toHaveLength(parts > 1 ? 1 : 0);
    sent.length = 0;
    const single: ClaimListView = { address: ADDRESS, size: 2, workers: workers.slice(0, 1), complete: false } as ClaimListView;
    const one = (await finishList(workers.slice(0, 2), owner, transport, ADDRESS, single, true)) as { summary: string[]; signatures: string[] };
    expect(one.signatures).toHaveLength(1);
    expect(one.summary.some((line) => line.startsWith("Sends:"))).toBe(false);
  });
});

describe("hand-over survivors", () => {
  it("closes dropped entries only when there are refunds and a dropper", () => {
    const entries = [{}, {}] as never;
    expect(handedTo({ entries, refunded: 0, dropper: ADDRESS } as never)).toStrictEqual(["Skips: 2 line entries whose worker left"]);
    expect(handedTo({ entries, refunded: 2 } as never)).toStrictEqual([]);
    expect(handedTo({ entries, refunded: 2, dropper: ADDRESS } as never)).toStrictEqual([
      "Closes: 2 line entries of " + ADDRESS + ", which dropped the claim and may not hold it again before its term ends; each entry's stake and rent go back to it",
    ]);
    expect(handedTo({ entries: [{}] as never, refunded: 1, dropper: ADDRESS } as never)[0]).toContain("Closes: 1 line entry of ");
  });
});

describe("signature lookup survivors", () => {
  const lookup = (found: object) => signatureLookup({ sendStatus: async () => found } as unknown as Transport, "sig", undefined);

  it("adds the engine error name only when the failure has one", async () => {
    const base = { status: "failed", signature: "sig", program: "prog", err: "bad" };
    expect(await lookup(base)).toStrictEqual({ status: "failed", signature: "sig", program: "prog", error: "'bad'" });
    expect(await lookup({ ...base, engine: { name: "Boom" } })).toStrictEqual({ status: "failed", signature: "sig", program: "prog", engine_error: "Boom", error: "'bad'" });
    expect(await lookup({ ...base, logs: ["a"] })).toStrictEqual({ status: "failed", signature: "sig", program: "prog", error: "'bad'", logs: ["a"] });
  });
});
