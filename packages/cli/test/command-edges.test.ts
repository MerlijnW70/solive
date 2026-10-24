import { getEventListeners } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client, ClaimsView, Transport } from "@intent-engine/client";
import { parse, takesSavedConfirm, UsageError } from "../src/args.js";
import { dropHandover, handedTo, lineWaiting } from "../src/claim-commands.js";
import { sameBallot, VOTE_KIND, voteOf } from "../src/committee-commands.js";
import { FlowRefused } from "../src/flows.js";
import { checkLedgerPaths } from "../src/ledger-keys.js";
import { EXIT_FAILED, nodeRuntime } from "../src/main.js";
import { MAX_SEALED_INPUT } from "../src/sealed-commands.js";
import { cli, h } from "./harness.js";

const ADDRESS = "11111111111111111111111111111111" as Address;
const SALT = "ab".repeat(16);
const OTHER_SALT = "cd".repeat(16);
const SHA256 = "ef".repeat(32);

const vote = (extra: Record<string, unknown> = {}) => ({
  kind: VOTE_KIND,
  intent: ADDRESS,
  committee: ADDRESS,
  owner: ADDRESS,
  nonce: "0",
  announcement: ADDRESS,
  sha256: SHA256,
  salt: SALT,
  result: "1",
  member: ADDRESS,
  signature: "0".repeat(128),
  ...extra,
});

describe("argument edges", () => {
  it("only judge, mcp and committee release take the saved second node", () => {
    expect([
      takesSavedConfirm("judge", undefined),
      takesSavedConfirm("mcp", undefined),
      takesSavedConfirm("committee", "release"),
      takesSavedConfirm("committee", "vote"),
      takesSavedConfirm("claims", "release"),
    ]).toEqual([true, true, true, false, false]);
  });

  it("profile show refuses a third word, which only profile encryption-key takes", () => {
    expect(() => parse(["profile", "show", "extra", "--wallet", ADDRESS])).toThrow(new UsageError("unexpected argument extra"));
  });

  it("set-mint-cap takes a window cap equal to the cap per order", () => {
    const limits = ["--mint", ADDRESS, "--max-per-order", "300", "--window-cap", "300", "--window-secs", "3600"];
    expect(parse(["set-mint-cap", "--keypair", "admin.json", ...limits])).toMatchObject({ name: "set-mint-cap", maxPerOrder: 300n, windowCap: 300n });
    expect(() => parse(["set-mint-cap", "--keypair", "admin.json", ...limits.slice(0, 5), "299", ...limits.slice(6)])).toThrow(
      new UsageError("--window-cap must be at least --max-per-order"),
    );
  });

  it("a saved Ledger path is checked only for mcp with a wallet", () => {
    const bad = "usb://ledger?key=x";
    expect(() => checkLedgerPaths(parse(["mcp", "--url", "devnet", "--wallet"]), bad)).toThrow(UsageError);
    expect(() => checkLedgerPaths(parse(["mcp", "--url", "devnet", "--wallet"]), bad)).toThrow(`--keypair ${bad}`);
    expect(() => checkLedgerPaths(parse(["mcp", "--url", "devnet"]), bad)).not.toThrow();
    expect(() => checkLedgerPaths(parse(["mcp", "--url", "devnet", "--wallet"]))).not.toThrow();
  });
});

describe("claim line wording and hand-over", () => {
  it("names one waiting worker in the singular and more in the plural", () => {
    expect(lineWaiting(ADDRESS, 1)).toContain("1 worker stands by for escrow");
    expect(lineWaiting(ADDRESS, 2)).toContain("2 workers stand by for escrow");
  });

  it("an empty hand-over adds no summary lines", () => {
    expect(handedTo({ entries: [] })).toStrictEqual([]);
    expect(handedTo({ entries: [ADDRESS], nextWorker: ADDRESS })).toStrictEqual([`Hands: the job to ${ADDRESS}, first in the line`]);
  });

  it("a drop on a closed escrow hands nothing over and never reads the line", async () => {
    const line = { head: 0, tail: 1, waiting: 1 };
    const view = { line } as ClaimsView;
    const client = { chainTime: async () => 0n, intent: async () => null } as unknown as Client;
    const refuse = async () => {
      throw new Error("the line was read");
    };
    const unread = { getAccount: refuse, getAccounts: refuse } as unknown as Transport;
    expect(await dropHandover(client, unread, ADDRESS, 0n, ADDRESS, view)).toStrictEqual({ entries: [] });
  });
});

describe("committee vote files", () => {
  it("reads a vote that names its announcement, sha256 and salt", () => {
    expect(voteOf(JSON.stringify(vote()), "v.json")).toStrictEqual(vote());
    expect(voteOf(JSON.stringify({ vote: vote() }), "v.json")).toStrictEqual(vote());
  });

  it("refuses a vote without its announcement, or with a sha256 or salt that is not lowercase hex", () => {
    expect(() => voteOf(JSON.stringify(vote({ announcement: undefined })), "v.json")).toThrow(new FlowRefused("v.json holds a committee vote without announcement"));
    expect(() => voteOf(JSON.stringify(vote({ salt: "XY".repeat(16) })), "v.json")).toThrow(new FlowRefused("v.json holds a salt that is not 32 lowercase hex digits"));
    expect(() => voteOf(JSON.stringify(vote({ sha256: "zz" })), "v.json")).toThrow(new FlowRefused("v.json holds a sha256 that is not 64 lowercase hex digits"));
  });

  it("agrees only when every vote names the same announcement and opening", () => {
    const a = voteOf(JSON.stringify(vote()), "a.json");
    expect(sameBallot([a, a], ["a.json", "b.json"])).toStrictEqual({ owner: ADDRESS, nonce: 0n, announcement: ADDRESS, sha256: SHA256, salt: SALT, result: 1n });
    const other = voteOf(JSON.stringify(vote({ salt: OTHER_SALT })), "c.json");
    expect(() => sameBallot([a, other], ["a.json", "c.json"])).toThrow(new FlowRefused(`c.json votes on salt ${OTHER_SALT}, but a.json votes on ${SALT}`));
  });
});

describe("the node runtime's sleep", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits the given seconds", async () => {
    vi.useFakeTimers();
    let woke: boolean | null = null;
    const slept = nodeRuntime().sleep(2).then((done) => {
      woke = done;
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(woke).toBe(null);
    await vi.advanceTimersByTimeAsync(1);
    await slept;
    expect(woke).toBe(true);
  });

  it("an abort ends the sleep and leaves no listener on the signal", async () => {
    const stop = new AbortController();
    const slept = nodeRuntime().sleep(60, stop.signal);
    expect(getEventListeners(stop.signal, "abort")).toHaveLength(1);
    stop.abort();
    expect(await slept).toBe(false);
    expect(getEventListeners(stop.signal, "abort")).toHaveLength(0);
  });
});

describe("sealed files and specs", () => {
  it("unseal reads a file of exactly the size limit and refuses one byte more", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bounded-"));
    h.files.set("k.json", JSON.stringify(Array.from({ length: 64 }, (_, i) => i)));
    const at = join(dir, "at.sealed");
    const over = join(dir, "over.sealed");
    await writeFile(at, new Uint8Array(MAX_SEALED_INPUT));
    await writeFile(over, new Uint8Array(MAX_SEALED_INPUT + 1));
    const fits = await cli(["unseal", "--file", at, "--keypair", "k.json", "--out", join(dir, "at.md")], {});
    expect([fits.code, fits.err]).toEqual([EXIT_FAILED, `${at}: this is not a sealed file`]);
    const big = await cli(["unseal", "--file", over, "--keypair", "k.json", "--out", join(dir, "over.md")], {});
    expect([big.code, big.err]).toEqual([EXIT_FAILED, `${over} is larger than ${MAX_SEALED_INPUT} bytes`]);
  }, 60_000);

});
