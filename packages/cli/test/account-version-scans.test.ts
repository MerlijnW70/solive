import type { Address, KeyPairSigner } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { ACCOUNT_LAYOUTS, findIntentPda, INTENT_VERSION } from "@intent-engine/core/internal";
import { EXIT_OK } from "../src/main.js";
import { intentLeftOut } from "../src/treasury.js";
import { ata, cli, funded, h, NOW, world } from "./harness.js";
import { createSwap } from "./cli-kit.js";
import { type Json, ok, served } from "./agent-kit.js";

const NEWER = `this intent account is of version ${INTENT_VERSION + 1}; this SDK reads intent versions 1 to ${INTENT_VERSION} only. Close it with intent-engine close-legacy`;

const VERSION_AT = 8 + (ACCOUNT_LAYOUTS.find((layout) => layout.name === "intent")?.versionAt ?? 0);

function storeNewerVersion(intent: Address): void {
  const account = h.svm.getAccount(intent);
  if (!account.exists) {
    throw new Error("intent missing");
  }
  const data = new Uint8Array(account.data);
  data[VERSION_AT] = INTENT_VERSION + 1;
  h.svm.setAccount({ ...account, data });
}

function passTime(to: bigint): void {
  const clock = h.svm.getClock();
  clock.unixTimestamp = to;
  h.svm.setClock(clock);
}

describe("scans over intents of a layout this version cannot read", () => {
  let authority: KeyPairSigner;
  let feeRecipient: KeyPairSigner;
  let owner: KeyPairSigner;
  let inputMint: Address;
  let outputMint: Address;
  const intentOf = async (nonce: bigint) => (await findIntentPda({ owner: owner.address, nonce }))[0];

  beforeEach(async () => {
    ({ authority, feeRecipient, owner, inputMint, outputMint } = await world());
    h.watched.length = 0;
    h.watched.push(owner.address);
  });

  const create = async (nonce: string, expiresAt: bigint) => {
    const made = await cli(createSwap(inputMint, outputMint, nonce, expiresAt), { "owner.json": owner });
    expect([made.code, made.err]).toEqual([EXIT_OK, ""]);
  };

  it("crank skips the newer intent, names it with the reason, and expires the valid one beside it", async () => {
    await create("0", NOW + 10n);
    await create("1", NOW + 10n);
    const [i0, i1] = await Promise.all([intentOf(0n), intentOf(1n)]);
    storeNewerVersion(i1);
    passTime(NOW + 10n);
    const cranker = await funded();
    const dry = await cli(["crank", "--keypair", "c.json", "--dry-run"], { "c.json": cranker });
    expect(dry.code).toBe(EXIT_OK);
    expect(dry.json()).toEqual({
      now: (NOW + 10n).toString(),
      dryRun: true,
      untouched: 0,
      actions: [{ intent: i0, action: "expire" }],
      unreadable: [{ intent: i1, skipped: NEWER }],
    });
    const wet = (await cli(["crank", "--keypair", "c.json"], { "c.json": cranker })).json() as Json;
    expect(wet["actions"].map((a: Json) => [a["intent"], a["action"], typeof a["signature"]])).toEqual([[i0, "expire", "string"]]);
    expect(wet["unreadable"]).toEqual([{ intent: i1, skipped: NEWER }]);
    expect(h.svm.getAccount(i0).exists).toBe(false);
    expect(h.svm.getAccount(i1).exists).toBe(true);
  });

  it("solve skips the newer intent with the reason and still plans the valid one beside it", async () => {
    await create("3", NOW + 3_600n);
    await create("4", NOW + 3_600n);
    const [i3, i4] = await Promise.all([intentOf(3n), intentOf(4n)]);
    storeNewerVersion(i3);
    await ata(authority, feeRecipient.address, inputMint);
    h.fetched.length = 0;
    h.jupiterReplies = [{ status: 404, body: {} }];
    const solver = await funded();
    const result = await cli(
      ["solve", "--keypair", "s.json", "--jupiter", "https://quote.example/swap/v1/", "--min-profit", `${outputMint}=40`, "--concurrency", "1"],
      { "s.json": solver },
    );
    expect(result.code).toBe(EXIT_OK);
    expect(result.json()).toEqual({
      filled: [],
      sent: [],
      skipped: [
        { intent: i3, reason: NEWER },
        { intent: i4, reason: "no route" },
      ],
      failed: [],
    });
    expect(h.fetched).toHaveLength(1);
  });

  it("treasury leaves the newer intent's token out with a warning naming it and lists the valid one's", async () => {
    await create("5", NOW + 3_600n);
    await create("6", NOW + 3_600n);
    const i5 = await intentOf(5n);
    storeNewerVersion(i5);
    const found = (await cli(["treasury"], {})).json() as Json;
    expect(found["tokens"].map((t: Json) => t["mint"])).toEqual([inputMint]);
    expect(found["warnings"]).toContain(intentLeftOut({ address: i5, reason: NEWER }));
    expect(intentLeftOut({ address: i5, reason: NEWER })).toBe(`the intent ${i5} was left out of the token list: ${NEWER}`);
  });
});

describe("crank work over intents of a layout this version cannot read", () => {
  it("lists the valid work and names the skipped intent with the reason", async () => {
    const { w, client } = await served();
    for (const [nonce, expiry] of [
      ["0", NOW + 10n],
      ["1", NOW + 10n],
    ] as const) {
      expect((await cli(createSwap(w.inputMint, w.outputMint, nonce, expiry), { "owner.json": w.owner })).code).toBe(EXIT_OK);
    }
    const [i0] = await findIntentPda({ owner: w.owner.address, nonce: 0n });
    const [i1] = await findIntentPda({ owner: w.owner.address, nonce: 1n });
    storeNewerVersion(i1);
    passTime(NOW + 10n);
    const work = await ok(client, "find_crank_work");
    expect(work["work"].map((item: Json) => [item["intent"], item["action"]])).toEqual([[i0, "expire"]]);
    expect(work["skipped"]).toEqual([{ intent: i1, reason: NEWER }]);
  });
});
