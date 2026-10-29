import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, createKeyPairSignerFromPrivateKeyBytes, generateKeyPairSigner } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, type Intent, IntentStatus, Kind, NATIVE_MINT } from "@intent-engine/core";
import { encodeParams, getIntentDecoder, getIntentSize, INTENT_VERSION } from "@intent-engine/core/internal";
import { loadConfig, MAX_SPEC_BYTES } from "@intent-engine/client/internal";
import { EXIT_OK } from "../src/main.js";
import { NO_JOB_MATCHES, NO_JOB_OPEN } from "../src/job-commands.js";
import { fillableSince, fillerFills } from "../src/monitor-health.js";
import { sealedOverLimit } from "../src/sealed-commands.js";
import { cli, NOW, transport, world, type World } from "./harness.js";

describe("jobs hint when none is listed", () => {
  let w: World;

  beforeEach(async () => {
    w = await world();
  });

  it("points to waiting when no filter was given", async () => {
    expect((await cli(["jobs"], {})).json()).toStrictEqual({ jobs: [], next: NO_JOB_OPEN });
  });

  it("says no job matches as soon as any single filter was given", async () => {
    const other = (await generateKeyPairSigner()).address;
    for (const filter of [["--attestor", other], ["--mint", w.inputMint], ["--min-pay", "1"], ["--unclaimed"]]) {
      const run = await cli(["jobs", ...filter], {});
      expect([filter, run.code, run.json()]).toStrictEqual([filter, EXIT_OK, { jobs: [], next: NO_JOB_MATCHES }]);
    }
  });
});

describe("seal warning", () => {
  it("warns about a sealed file only once it is larger than the spec limit", async () => {
    await world();
    const fixed = await Promise.all([12, 62].map(async (seed) => (await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(seed))).address));
    const recipient = fixed.join(",");
    const dir = await mkdtemp(join(tmpdir(), "kill-seal-"));
    const seal = async (name: string, size: number) => {
      const plain = join(dir, `${name}.md`);
      await writeFile(plain, "x".repeat(size));
      const out = join(dir, `${name}.sealed`);
      const run = await cli(["seal", "--file", plain, "--to", recipient, "--out", out], {});
      expect([run.code, run.err]).toStrictEqual([EXIT_OK, ""]);
      return { json: run.json(), size: (await readFile(out)).length };
    };
    let low = 1;
    let high = MAX_SPEC_BYTES;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((await seal(`probe-${middle}`, middle)).size < MAX_SPEC_BYTES) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const exact = await seal(`exact-${low}`, low);
    expect(exact.size).toBe(MAX_SPEC_BYTES);
    expect(exact.json).not.toHaveProperty("warnings");
    let more = low;
    let over = exact;
    while (over.size === MAX_SPEC_BYTES) {
      more += 1;
      over = await seal(`over-${more}`, more);
    }
    expect(over.size).toBeGreaterThan(MAX_SPEC_BYTES);
    expect(over.json["warnings"]).toStrictEqual([sealedOverLimit(over.size)]);
  }, 60_000);
});

describe("the filler's view of an order", () => {
  const SOLD = 50_000_000n;

  async function order(change: Partial<Intent> = {}) {
    const owner = (await generateKeyPairSigner()).address;
    const intent: Intent = {
      ...getIntentDecoder().decode(new Uint8Array(getIntentSize())),
      owner,
      receiver: owner,
      rentPayer: owner,
      inputMint: NATIVE_MINT,
      outputMint: DEVNET_TEST_MINT,
      escrowed: SOLD,
      createdAt: NOW - 100n,
      expiresAt: NOW + 3_600n,
      kind: Kind.SwapExactIn,
      status: IntentStatus.Open,
      version: INTENT_VERSION,
      feeBps: 5,
      params: encodeParams({ kind: Kind.SwapExactIn, amountIn: SOLD, minOut: 1n }),
      ...change,
    };
    return { address: (await generateKeyPairSigner()).address as Address, intent };
  }

  it("fills an order it can price, and never one it cannot", async () => {
    await world();
    const { config } = await loadConfig(transport);
    const fills = await order();
    expect(await fillerFills(fills.address, fills.intent, config, NOW)).toBe(true);
    const wrongOutput = await order({ outputMint: NATIVE_MINT });
    expect(await fillerFills(wrongOutput.address, wrongOutput.intent, config, NOW)).toBe(false);
    const wrongInput = await order({ inputMint: DEVNET_TEST_MINT });
    expect(await fillerFills(wrongInput.address, wrongInput.intent, config, NOW)).toBe(false);
  });

  it("reports an order it could not even evaluate as not fillable", async () => {
    const { address, intent } = await order();
    expect(await fillerFills(address, intent, undefined as never, NOW)).toBe(false);
    expect(await fillableSince(address, intent, undefined as never, NOW)).toBeNull();
  });

  it("dates a fillable order from its creation, or from now when it was created now or later", async () => {
    await world();
    const { config } = await loadConfig(transport);
    const early = await order();
    expect(await fillableSince(early.address, early.intent, config, NOW)).toBe(NOW - 100n);
    const now = await order({ createdAt: NOW });
    expect(await fillableSince(now.address, now.intent, config, NOW)).toBe(NOW);
    const future = await order({ createdAt: NOW + 5n });
    expect(await fillableSince(future.address, future.intent, config, NOW)).toBe(NOW);
  });
});
