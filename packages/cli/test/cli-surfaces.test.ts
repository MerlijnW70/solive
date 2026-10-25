import { type Address, generateKeyPairSigner, type KeyPairSigner, type Signature } from "@solana/kit";
import { getCloseAccountInstruction, getTransferInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { beforeEach, describe, expect, it } from "vitest";
import { TransactionMetadata } from "litesvm";
import { MAX_EXPIRES_IN, MIN_EXPIRES_IN } from "../src/agent/create.js";
import { NOT_SENT } from "../src/flows.js";
import { findAssociatedTokenAddress, formatAmount } from "@intent-engine/core";
import {
  getDeliveryReleasedEventEncoder,
  getIntentAttestedEventEncoder,
  getIntentCreatedEventEncoder,
  specMemo,
  findIntentPda,
  EVENT_IX_TAG,
} from "@intent-engine/core/internal";
import { needsSpecHash, SHA256_NEEDED, SPEC_HASH_FORMAT, usageOf } from "../src/args.js";
import { DEVNET_GENESIS_HASH, PLAIN_HTTP_ON_PUBLIC } from "@intent-engine/client/internal";
import { RELEASE_UNKNOWN } from "../src/agent/wallet.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, PREVIEW_ONLY } from "../src/main.js";
import { ata, balance, cli, ESCROW, funded, h, NOW, send, setNow, world, type World } from "./harness.js";
import { type Json } from "./cli-kit.js";

describe("the cli reaches what the other surfaces do", () => {
  let w: World;
  let keys: Record<string, KeyPairSigner>;

  beforeEach(async () => {
    w = await world();
    keys = { "owner.json": w.owner };
    h.engineLog = [];
  });

  const swap = (nonce: string, ...more: string[]) => [
    "create",
    "swap",
    "--keypair",
    "owner.json",
    "--nonce",
    nonce,
    "--input-mint",
    w.inputMint,
    "--output-mint",
    w.outputMint,
    "--expires-at",
    (NOW + 3_600n).toString(),
    "--amount-in",
    ESCROW.toString(),
    "--min-out",
    "300",
    "--units",
    "raw",
    ...more,
  ];

  const attested = (attestor: Address, ...more: string[]) => [
    "create",
    "attested",
    "--keypair",
    "owner.json",
    "--input-mint",
    w.inputMint,
    "--output-mint",
    w.outputMint,
    "--expires-in",
    "3600",
    "--amount-in",
    "0.0001",
    "--min-result",
    "1",
    "--max-result",
    "1",
    "--attestor",
    attestor,
    ...more,
  ];

  const grant = (maxTtl: string, validFor: string) => [
    "mandate",
    "grant",
    "--keypair",
    "owner.json",
    "--agent",
    w.authority.address,
    "--input-mint",
    w.inputMint,
    "--output-mint",
    w.outputMint,
    "--kinds",
    "swap",
    "--per-intent",
    "10",
    "--total",
    "100",
    "--max-intents",
    "5",
    "--max-ttl",
    maxTtl,
    "--valid-for",
    validFor,
    "--floor-out",
    "1",
    "--floor-in",
    "1",
    "--units",
    "raw",
  ];

  const shownIntent = async (nonce: string) => (await cli(["show", "intent", "--owner", w.owner.address, "--nonce", nonce], {})).json();

  it("create attested takes a spec hash judge fee and spec url", async () => {
    const judge = await generateKeyPairSigner();
    const specUrl = "https://example.org/spec.md";
    const args = attested(judge.address, "--nonce", "3", "--spec-hash", "AB".repeat(32), "--judge-fee", "0.00001", "--spec-url", specUrl);
    const preview = await cli(args, keys);
    expect([preview.code, preview.err]).toEqual([EXIT_OK, ""]);
    expect(preview.json()).toMatchObject({ sent: false, next: NOT_SENT });
    expect(preview.json()["summary"]).toContain(`Publishes: the acceptance spec's url ${specUrl}, in a memo the owner signs`);
    const made = await cli([...args, "--yes"], keys);
    expect([made.code, made.err]).toEqual([EXIT_OK, ""]);
    expect((await shownIntent("3"))["params"]).toEqual({
      kind: "AttestedResult",
      amountIn: "100",
      minResult: "1",
      maxResult: "1",
      attestor: judge.address,
      specHash: "ab".repeat(32),
      judgeFee: "10",
    });
    const [signature] = made.json()["signatures"] as Signature[];
    const landed = signature === undefined ? null : h.svm.getTransaction(signature);
    if (!(landed instanceof TransactionMetadata)) {
      throw new Error("the create did not land");
    }
    expect(landed.logs().some((line) => line.includes(specMemo(specUrl)))).toBe(true);
    expect(await cli(swap("4", "--spec-hash", "ab".repeat(32)), keys)).toMatchObject({ code: EXIT_USAGE, err: "a swap order does not take --spec-hash" });
    expect(await cli(attested(judge.address, "--spec-hash", "ab"), keys)).toMatchObject({ code: EXIT_USAGE, err: SPEC_HASH_FORMAT });
    h.genesis = DEVNET_GENESIS_HASH;
    const plain = "http://127.0.0.1:8080/spec.md";
    const refused = await cli(attested(judge.address, "--nonce", "5", "--spec-hash", "ab".repeat(32), "--spec-url", plain), keys);
    expect(refused).toMatchObject({ code: EXIT_FAILED, err: `--spec-url ${plain} ${PLAIN_HTTP_ON_PUBLIC}` });
  });

  it("create attested without a spec hash creates a plain attested escrow", async () => {
    const judge = await generateKeyPairSigner();
    const [intent] = await findIntentPda({ owner: w.owner.address, nonce: 3n });
    for (const option of ["--judge-fee", "--spec-url"] as const) {
      const value = option === "--judge-fee" ? "0.00001" : "https://example.org/spec.md";
      const refused = await cli(attested(judge.address, "--nonce", "3", option, value, "--yes"), keys);
      expect([refused.code, refused.err, refused.out]).toEqual([EXIT_USAGE, needsSpecHash(option.slice(2)), ""]);
    }
    expect(h.svm.getAccount(intent).exists).toBe(false);
    const preview = await cli(attested(judge.address, "--nonce", "3"), keys);
    expect([preview.code, preview.err]).toEqual([EXIT_OK, ""]);
    expect(preview.json()).toMatchObject({ sent: false, next: NOT_SENT });
    const made = await cli(attested(judge.address, "--nonce", "3", "--yes"), keys);
    expect([made.code, made.err]).toEqual([EXIT_OK, ""]);
    const params = (await shownIntent("3"))["params"] as Json;
    expect(params).toMatchObject({ kind: "AttestedResult", amountIn: "100", minResult: "1", maxResult: "1", attestor: judge.address });
    expect(params["specHash"] ?? "0".repeat(64)).toBe("0".repeat(64));
    expect(balance(w.ownerInput)).toBe(900n);
  });

  it("cancel adds a missing refund account", async () => {
    expect((await cli(swap("1", "--yes"), keys)).code).toBe(EXIT_OK);
    const sink = await ata(w.authority, (await generateKeyPairSigner()).address, w.inputMint);
    await send(w.owner, [
      getTransferInstruction({ source: w.ownerInput, destination: sink, authority: w.owner, amount: balance(w.ownerInput) }),
      getCloseAccountInstruction({ account: w.ownerInput, destination: w.owner.address, owner: w.owner }),
    ]);
    expect(h.svm.getAccount(w.ownerInput).exists).toBe(false);
    const preview = await cli(["cancel", "--keypair", "owner.json", "--nonce", "1", "--close"], keys);
    expect([preview.code, preview.err]).toEqual([EXIT_OK, PREVIEW_ONLY]);
    expect(preview.json()).toMatchObject({ sent: false, next: NOT_SENT });
    expect(preview.json()["summary"]).toContain(`Creates ${w.ownerInput} first, since it is missing; the owner pays its rent`);
    const [intent] = await findIntentPda({ owner: w.owner.address, nonce: 1n });
    const sent = await cli(["cancel", "--keypair", "owner.json", "--nonce", "1", "--close", "--yes"], keys);
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(sent.json()).toMatchObject({ intent, sent: true, signature: expect.any(String) });
    expect(balance(w.ownerInput)).toBe(ESCROW);
    expect(h.svm.getAccount(intent).exists).toBe(false);
  });

  it("a cancel preview says nothing was sent", async () => {
    expect((await cli(swap("1", "--yes"), keys)).code).toBe(EXIT_OK);
    const cancel = ["cancel", "--keypair", "owner.json", "--nonce", "1"];
    const preview = await cli(cancel, keys);
    expect([preview.code, preview.err]).toEqual([EXIT_OK, PREVIEW_ONLY]);
    expect(preview.json()).toMatchObject({ sent: false, next: NOT_SENT });
    expect(PREVIEW_ONLY).toBe("nothing was sent; pass --yes to sign and send it");
    const text = await cli([...cancel, "--output", "text"], keys);
    expect([text.code, text.err]).toEqual([EXIT_OK, PREVIEW_ONLY]);
    expect(text.out.split("\n")).toContain("sent: false");
    expect((await shownIntent("1"))["status"]).toBe("open");
    const sent = await cli([...cancel, "--yes"], keys);
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect((await shownIntent("1"))["status"]).toBe("cancelled");
    const created = await cli(swap("2"), keys);
    expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
  });

  it("cancel expire and close preview without yes", async () => {
    expect((await cli(swap("1", "--yes"), keys)).code).toBe(EXIT_OK);
    const shortLived = swap("2", "--yes");
    shortLived[shortLived.indexOf("--expires-at") + 1] = (NOW + 10n).toString();
    expect((await cli(shortLived, keys)).code).toBe(EXIT_OK);
    const cranker = await funded();
    const signers = { "c.json": cranker, "owner.json": w.owner };
    const [first] = await findIntentPda({ owner: w.owner.address, nonce: 1n });
    const [second] = await findIntentPda({ owner: w.owner.address, nonce: 2n });
    const steps: [string[], () => Promise<void>][] = [
      [["cancel", "--keypair", "owner.json", "--nonce", "1"], async () => expect((await shownIntent("1"))["status"]).toBe("cancelled")],
      [["close", "--keypair", "owner.json", "--owner", w.owner.address, "--nonce", "1"], async () => expect(h.svm.getAccount(first).exists).toBe(false)],
      [["expire", "--keypair", "c.json", "--owner", w.owner.address, "--nonce", "2"], async () => expect((await shownIntent("2"))["status"]).toBe("expired")],
    ];
    setNow(NOW + 10n);
    for (const [args, after] of steps) {
      const before = balance(w.ownerInput);
      const preview = await cli(args, signers);
      expect([preview.code, preview.err], args.join(" ")).toEqual([EXIT_OK, PREVIEW_ONLY]);
      expect(preview.json()).toMatchObject({ sent: false, next: NOT_SENT, summary: expect.any(Array) });
      expect(BigInt(preview.json()["units_consumed"] as string)).toBeGreaterThan(0n);
      expect(balance(w.ownerInput)).toBe(before);
      const sent = await cli([...args, "--yes"], signers);
      expect([sent.code, sent.err], args.join(" ")).toEqual([EXIT_OK, ""]);
      expect(sent.json()).toMatchObject({ sent: true, signature: expect.any(String) });
      await after();
    }
    expect(h.svm.getAccount(second).exists).toBe(true);
    expect(balance(w.ownerInput)).toBe(1_000n);
    expect(usageOf("cancel").usage).toBe("cancel [--keypair <file>] --nonce <n> [--close] [--yes]");
  });

  it("create takes pay to", async () => {
    const payee = await funded();
    const preview = await cli(swap("1", "--pay-to", payee.address), keys);
    expect([preview.code, preview.err]).toEqual([EXIT_OK, ""]);
    expect(preview.json()["summary"]).toContain(`Pays to: ${payee.address}, who receives what the solver pays`);
    expect((await cli(swap("1", "--pay-to", payee.address, "--yes"), keys)).code).toBe(EXIT_OK);
    const receiver = await findAssociatedTokenAddress({ owner: payee.address, mint: w.outputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect((await shownIntent("1"))["receiver"]).toBe(receiver);
    expect(h.svm.getAccount(receiver).exists).toBe(true);
    expect(await cli(swap("2", "--pay-to", "nope"), keys)).toMatchObject({ code: EXIT_USAGE, err: "--pay-to is not a base58 address" });
  });

  it("receipt prints the recorded delivery", async () => {
    const [intent] = await findIntentPda({ owner: w.owner.address, nonce: 7n });
    const receipt = ["receipt", "--owner", w.owner.address, "--nonce", "7"];
    expect((await cli(receipt, {})).json()).toEqual({ intent, released: false, complete: false, next: RELEASE_UNKNOWN });
    const worker = await generateKeyPairSigner();
    const judge = await generateKeyPairSigner();
    const payee = await ata(w.authority, worker.address, w.inputMint);
    const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
    const released = getIntentAttestedEventEncoder().encode({
      intent,
      owner: w.owner.address,
      solver: judge.address,
      payee,
      attestor: judge.address,
      amountIn: 2_500_000n,
      result: 2n,
      fee: 0n,
      net: 2_500_000n,
      filled: 2_500_000n,
      remaining: 0n,
      partnerFee: 0n,
    });
    const created = getIntentCreatedEventEncoder().encode({
      intent,
      owner: w.owner.address,
      nonce: 7n,
      kind: 4,
      inputMint: w.inputMint,
      outputMint: w.outputMint,
      receiver: w.owner.address,
      escrowed: 2_500_000n,
      expiresAt: 0n,
      rentPayer: w.owner.address,
      flags: 0,
      bounty: 0,
      createFee: 0,
    });
    const work = "c".repeat(64);
    const salt = "5a".repeat(16);
    const announcement = (await generateKeyPairSigner()).address;
    const delivered = getDeliveryReleasedEventEncoder().encode({
      intent,
      announcement,
      seq: 4n,
      worker: worker.address,
      attestor: judge.address,
      delivered: Buffer.from(work, "hex"),
      salt: Buffer.from(salt, "hex"),
      splitHash: new Uint8Array(32),
    });
    const release = { signature: "release", slot: 3n, blockTime: null, failed: false, emitted: [tag(delivered), tag(released)] };
    h.engineLog = [{ ...release, signature: "failed", failed: true }, release, { signature: "create", slot: 1n, blockTime: null, failed: false, emitted: [tag(created)] }];
    const recorded = {
      intent,
      released: true,
      attestor: judge.address,
      result: "2",
      signature: "release",
      delivered_sha256: work,
      delivered_salt: salt,
      announcement,
      seq: "4",
      announcer: worker.address,
      standing_complete: false,
      paid_to: worker.address,
      payee,
      paid: formatAmount(2_500_000n, 6),
      mint: w.inputMint,
    };
    expect((await cli([...receipt, "--sha256", work.toUpperCase()], {})).json()).toEqual({ ...recorded, matches: true });
    expect((await cli([...receipt, "--sha256", "d".repeat(64)], {})).json()).toEqual({ ...recorded, matches: false });
    expect((await cli(receipt, {})).json()).toEqual(recorded);
    expect(await cli([...receipt, "--sha256", "xyz"], {})).toMatchObject({ code: EXIT_USAGE, err: SHA256_NEEDED });
    expect((await cli([...receipt, "--output", "text"], {})).out).toContain(`delivered_sha256: ${work}`);
  });

  it("durations below a minute name the cli flag", async () => {
    const timeless = swap("1", "--yes").filter((a) => a !== "--expires-at" && a !== (NOW + 3_600n).toString());
    const refusals = [
      [[...timeless, "--expires-in", "59"], `--expires-in must be an integer from ${MIN_EXPIRES_IN} to ${MAX_EXPIRES_IN}`],
      [grant("59", "3600"), `--max-ttl must be an integer from ${MIN_EXPIRES_IN} to ${MAX_EXPIRES_IN}`],
      [grant("3600", "59"), `--valid-for must be an integer from ${MIN_EXPIRES_IN} to ${MAX_EXPIRES_IN}`],
    ] as const;
    for (const [args, refusal] of refusals) {
      const run = await cli([...args], keys);
      expect([run.code, run.err, run.out]).toEqual([EXIT_USAGE, refusal, ""]);
    }
    expect((await cli([...timeless, "--expires-in", String(MIN_EXPIRES_IN)], keys)).code).toBe(EXIT_OK);
  });
});
