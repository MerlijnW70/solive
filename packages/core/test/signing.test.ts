import { type Address, getAddressDecoder, getAddressEncoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  createExt,
  describeSignedIntent,
  type DescribeOptions,
  encodeParams,
  formatAmount,
  formatTime,
  type IntentParams,
  Kind,
  offchainEnvelope,
  parseAmount,
  type SignedIntentFields,
  signedIntentMessage,
  signedIntentPreimage,
  U64_MAX,
} from "../src/index.js";

const TOKEN_PROGRAM_ADDRESS = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

const CASES = Number(process.env["SIGNING_CASES"] ?? "1500");
const TIMEOUT = 600_000;
const NOW = 1_700_000_000n;
const I64_SPAN = 1n << 62n;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Gen = ReturnType<typeof gen>;

function gen(seed: number) {
  const random = rng(seed);
  const int = (n: number) => Math.floor(random() * n);
  const bytes = (n: number) => Uint8Array.from({ length: n }, () => int(256));
  const word = () => {
    const pick = int(4);
    if (pick === 0) {
      return BigInt(1 + int(1_000));
    }
    if (pick === 1) {
      return U64_MAX - BigInt(int(3));
    }
    return BigInt.asUintN(64, (BigInt(int(2 ** 32)) << 32n) | BigInt(int(2 ** 32))) || 1n;
  };
  const time = () => NOW + BigInt(int(2_000_000)) - 1_000_000n;
  const key = (): Address => getAddressDecoder().decode(bytes(32));
  const params = (kind: Kind): IntentParams => {
    switch (kind) {
      case Kind.SwapExactIn:
        return { kind, amountIn: word(), minOut: word() };
      case Kind.LimitOrder:
        return { kind, makeAmount: word(), takeAmount: word() };
      case Kind.DutchAuction: {
        const [a, b] = [word(), word()];
        const startTs = time();
        return {
          kind,
          amountIn: word(),
          startOut: a > b ? a : b,
          endOut: a > b ? b : a,
          startTs,
          endTs: startTs + 1n + BigInt(int(100_000)),
        };
      }
      case Kind.AttestedResult: {
        const [a, b] = [word(), word()];
        return { kind, amountIn: word(), minResult: a < b ? a : b, maxResult: a < b ? b : a, attestor: key() };
      }
    }
  };
  const kind = (): Kind => [Kind.SwapExactIn, Kind.LimitOrder, Kind.DutchAuction, Kind.AttestedResult][int(4)] as Kind;
  const fields = (): SignedIntentFields => {
    const k = kind();
    const expiresAt = time();
    return {
      domain: bytes(32),
      owner: key(),
      ownerInput: key(),
      inputMint: key(),
      outputMint: key(),
      receiver: key(),
      nonce: BigInt(int(2 ** 31)),
      expiresAt,
      submitBy: time(),
      kind: k,
      params: encodeParams(params(k)),
      epoch: BigInt(int(1_000)),
      relayerFee: int(2) === 0 ? 0n : word(),
      ext: int(2) === 0 ? new Uint8Array() : createExt({ partner: { key: key(), bps: 1 + int(100) } }),
    };
  };
  const options = (f: SignedIntentFields): DescribeOptions => ({
    now: NOW,
    currentEpoch: f.epoch + BigInt(int(3)),
    expectedDomain: int(2) === 0 ? f.domain : bytes(32),
    outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
    ...(int(4) === 0 ? {} : { inputDecimals: int(19), outputDecimals: int(19) }),
  });
  return { random, int, bytes, word, time, key, params, kind, fields, options };
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b.slice()));
const readable = (lines: string[]) => lines.filter((l) => !l.startsWith("Digest"));

type Mutation = { name: string; apply: (f: SignedIntentFields, g: Gen) => SignedIntentFields };

const mutations: Mutation[] = [
  { name: "domain", apply: (f, g) => ({ ...f, domain: g.bytes(32) }) },
  { name: "owner", apply: (f, g) => ({ ...f, owner: g.key() }) },
  { name: "ownerInput", apply: (f, g) => ({ ...f, ownerInput: g.key() }) },
  { name: "inputMint", apply: (f, g) => ({ ...f, inputMint: g.key() }) },
  { name: "outputMint", apply: (f, g) => ({ ...f, outputMint: g.key() }) },
  { name: "receiver", apply: (f, g) => ({ ...f, receiver: g.key() }) },
  { name: "nonce", apply: (f) => ({ ...f, nonce: f.nonce + 1n }) },
  { name: "expiresAt", apply: (f) => ({ ...f, expiresAt: f.expiresAt + 1n }) },
  { name: "submitBy", apply: (f) => ({ ...f, submitBy: f.submitBy - 1n }) },
  { name: "epoch", apply: (f) => ({ ...f, epoch: f.epoch === 0n ? 0n : f.epoch - 1n }) },
  { name: "relayerFee", apply: (f) => ({ ...f, relayerFee: (f.relayerFee ?? 0n) === 0n ? 1n : (f.relayerFee ?? 0n) - 1n }) },
  {
    name: "partner",
    apply: (f, g) => ({ ...f, ext: createExt({ partner: { key: g.key(), bps: 1 + g.int(100) } }) }),
  },
  {
    name: "kind and params",
    apply: (f, g) => {
      const k = g.kind();
      return { ...f, kind: k, params: encodeParams(g.params(k)) };
    },
  },
  {
    name: "one param field",
    apply: (f) => {
      const params = Uint8Array.from(f.params);
      params[0] = (params[0] ?? 0) ^ 1;
      return { ...f, params };
    },
  },
  { name: "program", apply: (f, g) => ({ ...f, program: g.key() }) },
];

const changed = async (f: SignedIntentFields, g: SignedIntentFields) =>
  hex(await signedIntentPreimage(f)) !== hex(await signedIntentPreimage(g));

describe("what an owner reads is what an owner signs", () => {
  it("shows the digest of the exact 448-byte preimage and wraps that digest, and only it, in the message", async () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const g = gen(seed);
      const f = g.fields();
      const o = g.options(f);
      const preimage = await signedIntentPreimage(f);
      expect(preimage).toHaveLength(448);
      const digest = await sha256(preimage);
      const described = await describeSignedIntent(f, o);
      expect(described.digest, `seed ${seed}`).toBe(hex(digest));
      expect(described.lines.at(-1)).toBe(`Digest (must match your wallet): ${hex(digest)}`);
      expect(hex(await signedIntentMessage(f))).toBe(hex(offchainEnvelope(f.owner, digest)));
      const message = await signedIntentMessage(f);
      expect(new TextDecoder().decode(message).includes(hex(digest))).toBe(true);
      expect(hex(message).includes(hex(Uint8Array.from(getAddressEncoder().encode(f.owner))))).toBe(true);
    }
  }, TIMEOUT);

  it("changes the readable summary, not only the digest, whenever any signed field changes", async () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const g = gen(seed);
      const f = g.fields();
      const o = g.options(f);
      const m = mutations[g.int(mutations.length)] as Mutation;
      const h = m.apply(f, g);
      if (!(await changed(f, h))) {
        continue;
      }
      const before = readable((await describeSignedIntent(f, o)).lines);
      let after: string[];
      try {
        after = readable((await describeSignedIntent(h, { ...o, currentEpoch: o.currentEpoch })).lines);
      } catch {
        continue;
      }
      expect(after, `seed ${seed}: changing ${m.name} left the summary unchanged`).not.toEqual(before);
    }
  }, TIMEOUT);

  it("covers every signed field with a mutation that is visible", async () => {
    const g = gen(42);
    const f = { ...g.fields(), relayerFee: 5n, ext: createExt({ partner: { key: g.key(), bps: 7 } }), program: g.key() };
    const o = { ...g.options(f), currentEpoch: f.epoch + 1n };
    const before = readable((await describeSignedIntent(f, o)).lines);
    for (const m of mutations) {
      const h = m.apply(f, g);
      expect(await changed(f, h), m.name).toBe(true);
      const after = readable((await describeSignedIntent(h, o)).lines);
      expect(after, m.name).not.toEqual(before);
    }
  }, TIMEOUT);

  it("refuses to describe bytes it would not show: non-canonical params, unknown ext, flags, a future epoch", async () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const g = gen(seed);
      const f = g.fields();
      const o = g.options(f);
      const params = Uint8Array.from(f.params);
      const used = { 1: 16, 2: 16, 3: 40, 4: 56 }[f.kind] ?? 0;
      const at = used + g.int(128 - used);
      params[at] = 1 + g.int(255);
      await expect(describeSignedIntent({ ...f, params }, o), `seed ${seed} padding byte ${at}`).rejects.toThrow();
      const junk = Uint8Array.from([...Array.from(f.ext ?? new Uint8Array()), 9 + g.int(200), 0, 0]);
      await expect(describeSignedIntent({ ...f, ext: junk }, o), `seed ${seed} ext`).rejects.toThrow();
      await expect(describeSignedIntent({ ...f, flags: 1 + g.int(0xffff) }, o), `seed ${seed} flags`).rejects.toThrow();
      await expect(describeSignedIntent(f, { ...o, currentEpoch: f.epoch - 1n }), `seed ${seed} epoch`).rejects.toThrow();
    }
  }, TIMEOUT);

  it("formats amounts that parse back to the exact raw value and times that never collide", () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const g = gen(seed);
      const raw = g.word();
      const decimals = g.int(19);
      expect(parseAmount(formatAmount(raw, decimals), decimals), `seed ${seed}`).toBe(raw);
      expect(formatAmount(raw + (raw === U64_MAX ? -1n : 1n), decimals)).not.toBe(formatAmount(raw, decimals));
      const t = BigInt(g.int(2 ** 31)) * (g.int(2) === 0 ? 1n : -1n) + (g.int(5) === 0 ? I64_SPAN : 0n);
      expect(formatTime(t + 1n), `seed ${seed}`).not.toBe(formatTime(t));
    }
  }, TIMEOUT);
});
