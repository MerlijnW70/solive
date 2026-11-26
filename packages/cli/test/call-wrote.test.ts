import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { type Address, lamports } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvalidInput } from "../src/agent/schema.js";
import { walletWorker } from "../src/agent/wallet/worker.js";
import { keepReviewRecord } from "../src/review-record.js";
import { approved } from "./approved.js";
import { call, cancelledOver, hireWith, makeWorker, removeWorkFiles, startHirer } from "./local-worker-kit.js";
import { h } from "./harness.js";
import { takeMisses } from "./answer-guard.js";

const CLUSTER = "cluster";
const INTENT = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const SPEC = "ab".repeat(32);

describe("what a call recorded as written", () => {
  it("records a review record only when it really wrote one", async () => {
    const home = await mkdtemp(join(tmpdir(), "wrote-"));
    const wrote: string[] = [];
    const record = { cluster: CLUSTER, intent: INTENT as Address, specSha256: SPEC, review: null };
    expect(await keepReviewRecord(home, record, (path) => wrote.push(path))).toBeUndefined();
    expect(wrote).toHaveLength(1);
    expect(await keepReviewRecord(home, record, (path) => wrote.push(path))).toBeUndefined();
    expect(wrote).toHaveLength(1);
    const other = { ...record, intent: "11111111111111111111111111111112" as Address };
    expect(await keepReviewRecord(join(home, "missing", "\0bad"), other, (path) => wrote.push(path))).toContain("could not be written");
    expect(wrote).toHaveLength(1);
  });
});

describe("a worker call that fails after its local files changed", () => {
  let hirer: Client;
  let wallet: Address;

  beforeEach(async () => {
    ({ hirer, wallet } = await startHirer());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    removeWorkFiles();
  });

  it("names the key and job files it created and the files it deleted", async () => {
    const { intent } = await hireWith(hirer, wallet, false);
    const read = walletWorker.output.read;
    vi.spyOn(walletWorker.output, "read").mockImplementation((value, path) => {
      if ((value as { sent?: unknown }).sent === true) {
        throw new InvalidInput([{ path: "x", message: "is not a known field" }]);
      }
      return read(value, path);
    });
    const failed = await call(hirer, "wallet_worker", await approved(hirer, "wallet_worker", { intent }));
    expect(failed.error).toBe(true);
    const wrote = failed.value["wrote"] as string[];
    expect(wrote).toHaveLength(2);
    expect(wrote[0]).toMatch(/^saved .*\.json$/);
    expect(wrote[1]).toMatch(/^saved .*\.job\.json$/);
    for (const entry of wrote) {
      expect(h.files.has(entry.slice("saved ".length))).toBe(true);
    }
    expect(await takeMisses()).toHaveLength(1);
  }, 60_000);

  it("names the key and job files a return deleted", async () => {
    const job = await hireWith(hirer, wallet, false);
    const { worker, keypair } = await makeWorker(hirer, job.intent);
    await cancelledOver(hirer, job.nonce);
    const read = walletWorker.output.read;
    vi.spyOn(walletWorker.output, "read").mockImplementation((value, path) => {
      if ((value as { key_deleted?: unknown }).key_deleted === true) {
        throw new InvalidInput([{ path: "x", message: "is not a known field" }]);
      }
      return read(value, path);
    });
    h.svm.setAccount({ address: worker, data: new Uint8Array(), executable: false, lamports: lamports(0n), programAddress: "11111111111111111111111111111111" as Address, space: 0n });
    const failed = await call(hirer, "wallet_worker", { return_leftovers: worker, send: true });
    expect(failed.error).toBe(true);
    const wrote = failed.value["wrote"] as string[];
    expect(wrote).toEqual([`deleted ${keypair}`, `deleted ${keypair.replace(/\.json$/, ".job.json")}`]);
    expect(h.files.has(keypair)).toBe(false);
    await takeMisses();
  }, 60_000);
});
