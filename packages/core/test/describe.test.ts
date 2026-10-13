import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Address, getBase16Encoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  describeSignedIntent,
  encodePartner,
  encodeParams,
  findAssociatedTokenAddress,
  formatAmount,
  parseAmount,
  U64_MAX,
  formatTime,
  IntentCoreError,
  type IntentParams,
  Kind,
  LONG_LIVED_SECONDS,
  LONG_SUBMIT_SECONDS,
  type SignedIntentFields,
  settlementWarnings,
  signedIntentPreimage,
  WARN_ATTESTOR,
  WARN_DOMAIN,
  WARN_LONG_LIVED,
  WARN_LONG_SUBMIT,
  WARN_PROOF,
  WARN_RELAYER_FEE,
  WARN_RECEIVER,
  WARN_STALE_EPOCH,
  decodeParams,
  escrowAmount,
} from "../src/index.js";

const hexOf = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("./golden/vectors.json", import.meta.url)), "utf8"),
) as {
  keys: { owner: string; input_mint: string; output_mint: string };
  sig: {
    domain: string;
    receiver: string;
    owner_input: string;
    nonce: string;
    expires_at: string;
    submit_by: string;
    kind: string;
    params: string;
    digest: string;
    flags: string;
    epoch: string;
    ext: string;
  };
};
const bytes = (hex: string) => new Uint8Array(getBase16Encoder().encode(hex));
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const ATTESTOR = "So11111111111111111111111111111111111111112" as Address;
const s = vectors.sig;
const golden: SignedIntentFields = {
  domain: bytes(s.domain),
  owner: vectors.keys.owner as Address,
  ownerInput: s.owner_input as Address,
  inputMint: vectors.keys.input_mint as Address,
  outputMint: vectors.keys.output_mint as Address,
  receiver: s.receiver as Address,
  nonce: BigInt(s.nonce),
  expiresAt: BigInt(s.expires_at),
  submitBy: BigInt(s.submit_by),
  kind: Number(s.kind),
  params: bytes(s.params),
  epoch: BigInt(s.epoch),
};
const now = BigInt(s.expires_at) - 3_600n;
const options = { now, currentEpoch: BigInt(s.epoch), outputTokenProgram: TOKEN };

async function own(fields: SignedIntentFields): Promise<SignedIntentFields> {
  const receiver = await findAssociatedTokenAddress({
    owner: fields.owner,
    mint: fields.outputMint,
    tokenProgram: TOKEN,
  });
  return { ...fields, receiver };
}

function withParams(fields: SignedIntentFields, params: IntentParams): SignedIntentFields {
  return { ...fields, kind: params.kind, params: encodeParams(params) };
}

describe("signed intent description", () => {
  it("ends with the exact digest that gets signed", async () => {
    const d = await describeSignedIntent(golden, options);
    const digest = hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", (await signedIntentPreimage(golden)).slice())));
    expect(d.digest).toBe(digest);
    expect(d.lines.at(-1)).toBe(`Digest (must match your wallet): ${digest}`);
    expect(d.lines).toContain(
      `Revoke: this signature stays usable until ${formatTime(golden.submitBy)}; cancel it sooner by advancing your signing epoch or your nonce base past it, or by revoking the engine's spending allowance`,
    );
  });

  it("refuses an epoch ahead of the owner's, which a later revocation would arm", async () => {
    const ahead = { ...golden, epoch: options.currentEpoch + 1n };
    await expect(describeSignedIntent(ahead, options)).rejects.toThrow(
      `refusing to describe a signature for epoch ${ahead.epoch}: the owner is at epoch ${options.currentEpoch}, and a later epoch change would arm it`,
    );
    const behind = await describeSignedIntent(await own({ ...golden, epoch: options.currentEpoch - 1n }), options);
    expect(behind.warnings).toEqual([WARN_STALE_EPOCH]);
    const current = await describeSignedIntent(await own(golden), options);
    expect(current.warnings).toEqual([]);
  });

  it("refuses flags or extensions the program would reject", async () => {
    await expect(describeSignedIntent({ ...golden, flags: 1 }, options)).rejects.toThrow(
      new IntentCoreError("FlagsUnknown"),
    );
    await expect(describeSignedIntent({ ...golden, ext: new Uint8Array([2, 0, 0]) }, options)).rejects.toThrow(
      new IntentCoreError("ExtUnknown"),
    );
    await expect(describeSignedIntent({ ...golden, ext: new Uint8Array([1, 0, 0]) }, options)).rejects.toThrow(
      new IntentCoreError("ExtMalformed"),
    );
  });

  it("names the partner and its share when the intent carries one", async () => {
    const base = await own(golden);
    const shared = await describeSignedIntent({ ...base, ext: encodePartner({ key: ATTESTOR, bps: 25 }) }, options);
    expect(shared.lines).toContain(`Partner fee: 25 bps of the sold amount to ${ATTESTOR}`);
    const plain = await describeSignedIntent(base, options);
    expect(plain.lines.some((l) => l.startsWith("Partner fee"))).toBe(false);
  });

  it("names the relayer fee and warns when it passes 1% of what is sold", async () => {
    const base = withParams(await own(golden), { kind: Kind.SwapExactIn, amountIn: 10_000n, minOut: 1n });
    const escrow = escrowAmount(decodeParams(base.kind, base.params));
    expect(escrow).toBe(10_000n);
    const fair = await describeSignedIntent({ ...base, relayerFee: escrow / 100n }, options);
    expect(fair.warnings).toEqual([]);
    expect(fair.lines).toContain(
      `Relayer fee: ${escrow / 100n} raw units of ${base.inputMint}, paid from ${base.ownerInput} to whoever submits it`,
    );
    const steep = await describeSignedIntent({ ...base, relayerFee: escrow / 100n + 1n }, options);
    expect(steep.warnings).toEqual([WARN_RELAYER_FEE]);
    const free = await describeSignedIntent(base, options);
    expect(free.lines.some((l) => l.startsWith("Relayer fee"))).toBe(false);
  });

  it("warns at the exact submit-window and cluster boundaries", async () => {
    const base = await own(golden);
    const edge = await describeSignedIntent({ ...base, submitBy: now + LONG_SUBMIT_SECONDS }, options);
    expect(edge.warnings).toEqual([]);
    const beyond = await describeSignedIntent({ ...base, submitBy: now + LONG_SUBMIT_SECONDS + 1n }, options);
    expect(beyond.warnings).toEqual([WARN_LONG_SUBMIT]);
    expect(LONG_SUBMIT_SECONDS).toBe(86_400n);
    const same = await describeSignedIntent(base, { ...options, expectedDomain: bytes(s.domain) });
    expect(same.warnings).toEqual([]);
    const other = await describeSignedIntent(base, { ...options, expectedDomain: new Uint8Array(32).fill(7) });
    expect(other.warnings).toEqual([WARN_DOMAIN]);
    expect(other.lines).toContain(`WARNING: ${WARN_DOMAIN}`);
  });

  it("lays out every signed field in order", async () => {
    const fields = await own(withParams(golden, { kind: Kind.SwapExactIn, amountIn: 400n, minOut: 300n }));
    const d = await describeSignedIntent({ ...fields, program: TOKEN }, options);
    expect(d.lines.slice(0, -1)).toEqual([
      `Owner: ${fields.owner}`,
      `Pays from: ${fields.ownerInput}`,
      `Sell: exactly 400 raw units of ${fields.inputMint}`,
      `Receive: at least 300 raw units of ${fields.outputMint}`,
      `Receiver: ${fields.receiver}`,
      `Expires: ${formatTime(fields.expiresAt)}`,
      `Submit by: ${formatTime(fields.submitBy)}`,
      `Nonce: ${fields.nonce}`,
      `Signing epoch: ${fields.epoch}`,
      `Cluster domain: ${s.domain.toLowerCase()}`,
      `Program: ${TOKEN}`,
      `Revoke: this signature stays usable until ${formatTime(fields.submitBy)}; cancel it sooner by advancing your signing epoch or your nonce base past it, or by revoking the engine's spending allowance`,
    ]);
    expect(d.warnings).toEqual([]);
    const plain = await describeSignedIntent(fields, options);
    expect(plain.lines.some((l) => l.startsWith("Program:"))).toBe(false);
  });

  it("states the terms of each kind in plain words", async () => {
    const base = await own(golden);
    const at = (p: IntentParams) =>
      describeSignedIntent(withParams(base, p), { ...options, inputDecimals: 0, outputDecimals: 2 });
    const limit = await at({ kind: Kind.LimitOrder, makeAmount: 7n, takeAmount: 250n });
    expect(limit.lines.slice(2, 4)).toEqual([
      `Sell: exactly 7 of ${base.inputMint}`,
      `Receive: at least 2.5 of ${base.outputMint}`,
    ]);
    const dutch = await at({
      kind: Kind.DutchAuction,
      amountIn: 9n,
      startOut: 1_000n,
      endOut: 400n,
      startTs: now,
      endTs: now + 100n,
    });
    expect(dutch.lines[3]).toBe(
      `Receive: at least 10 of ${base.outputMint} at ${formatTime(now)}, falling to 4 of ${base.outputMint} at ${formatTime(now + 100n)}`,
    );
    const attested = await at({
      kind: Kind.AttestedResult,
      amountIn: 5n,
      minResult: 10n,
      maxResult: 20n,
      attestor: ATTESTOR,
      specHash: new Uint8Array(32),
      judgeFee: 0n,
    });
    expect(attested.lines.slice(2, 4)).toEqual([
      `Sell: exactly 5 of ${base.inputMint}`,
      `Settles: when ${ATTESTOR} attests a result between 10 and 20`,
    ]);
    expect(attested.warnings).toEqual([WARN_ATTESTOR]);
    expect(attested.lines).toContain(`WARNING: ${WARN_ATTESTOR}`);
  });

  it("warns that a proof escrow binds the verdict to its spec, and a plain attested escrow does not", () => {
    const attested = { kind: Kind.AttestedResult, amountIn: 5n, minResult: 1n, maxResult: 1n, attestor: ATTESTOR, judgeFee: 0n } as const;
    expect(settlementWarnings({ ...attested, specHash: new Uint8Array(32) })).toEqual([WARN_ATTESTOR]);
    expect(settlementWarnings({ ...attested, specHash: new Uint8Array(32).fill(1) })).toEqual([WARN_PROOF]);
    expect(settlementWarnings({ ...attested, specHash: Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 1 : 0)) })).toEqual([WARN_PROOF]);
    expect(settlementWarnings({ kind: Kind.SwapExactIn, amountIn: 5n, minOut: 1n })).toEqual([]);
  });

  it("warns at the exact long-lived and receiver boundaries", async () => {
    const base = await own(golden);
    const edge = await describeSignedIntent({ ...base, expiresAt: now + LONG_LIVED_SECONDS }, options);
    expect(edge.warnings).toEqual([]);
    const beyond = await describeSignedIntent({ ...base, expiresAt: now + LONG_LIVED_SECONDS + 1n }, options);
    expect(beyond.warnings).toEqual([WARN_LONG_LIVED]);
    expect(LONG_LIVED_SECONDS).toBe(2_592_000n);
    const elsewhere = await describeSignedIntent({ ...base, receiver: ATTESTOR }, options);
    expect(elsewhere.warnings).toEqual([WARN_RECEIVER]);
    expect(elsewhere.lines).toContain(`WARNING: ${WARN_RECEIVER}`);
  });

  it("refuses to describe params the program would reject", async () => {
    const bad = withParams(golden, { kind: Kind.SwapExactIn, amountIn: 1n, minOut: 1n });
    bad.params[127] = 1;
    await expect(describeSignedIntent(bad, options)).rejects.toThrow();
  });
});

describe("formatting", () => {
  it("formats amounts with and without decimals", () => {
    expect(formatAmount(1_234_567n)).toBe("1234567 raw units");
    expect(formatAmount(1_234_567n, 6)).toBe("1.234567");
    expect(formatAmount(1_000_000n, 6)).toBe("1");
    expect(formatAmount(1_500_000n, 6)).toBe("1.5");
    expect(formatAmount(5n, 6)).toBe("0.000005");
    expect(formatAmount(42n, 0)).toBe("42");
    expect(formatAmount(1n, 255)).toBe(`0.${"0".repeat(254)}1`);
    for (const decimals of [-1, 256, 1.5]) {
      expect(() => formatAmount(1n, decimals)).toThrow(`${decimals} is not a token decimals value`);
    }
  });

  it("reads token amounts exactly, refusing extra decimals, malformed text and overflow", () => {
    expect(parseAmount("1.5", 6)).toBe(1_500_000n);
    expect(parseAmount("0.000005", 6)).toBe(5n);
    expect(parseAmount("12", 6)).toBe(12_000_000n);
    expect(parseAmount("42", 0)).toBe(42n);
    expect(parseAmount("0", 255)).toBe(0n);
    expect(parseAmount("007.10", 2)).toBe(710n);
    for (const raw of [0n, 1n, 1_234_567n, 1_000_000n, U64_MAX]) {
      expect(parseAmount(formatAmount(raw, 6), 6)).toBe(raw);
    }
    expect(parseAmount("18446744073709.551615", 6)).toBe(U64_MAX);
    expect(() => parseAmount("18446744073709.551616", 6)).toThrow("18446744073709.551616 is more than a token account can hold");
    expect(() => parseAmount("0.0000001", 6)).toThrow("0.0000001 has more than the token's 6 decimal places");
    expect(() => parseAmount("1.5", 0)).toThrow("1.5 has more than the token's 0 decimal places");
    for (const bad of ["", ".5", "1.", "-1", "1e6", "1,5", " 1"]) {
      expect(() => parseAmount(bad, 6)).toThrow(`${bad} is not a token amount like 12 or 0.5`);
    }
    for (const decimals of [-1, 256, 1.5]) {
      expect(() => parseAmount("1", decimals)).toThrow(`${decimals} is not a token decimals value`);
    }
  });

  it("formats times as UTC and falls back outside the date range", () => {
    expect(formatTime(0n)).toBe("1970-01-01T00:00:00.000Z");
    expect(formatTime(1_700_000_000n)).toBe("2023-11-14T22:13:20.000Z");
    expect(formatTime(8_640_000_000_000n)).toBe("+275760-09-13T00:00:00.000Z");
    expect(formatTime(8_640_000_000_001n)).toBe("unix 8640000000001");
    expect(formatTime(-8_640_000_000_000n)).toBe("-271821-04-20T00:00:00.000Z");
    expect(formatTime(-8_640_000_000_001n)).toBe("unix -8640000000001");
  });
});
