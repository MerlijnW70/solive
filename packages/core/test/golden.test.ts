import { readFileSync } from "node:fs";
import * as core from "../src/index.js";
import { fileURLToPath } from "node:url";
import {
  type Address,
  getAddressEncoder,
  getBase16Encoder,
  getOffchainMessageV1Encoder,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  decodeParams,
  encodeParams,
  escrowAmount,
  findAssociatedTokenAddress,
  findConfigPda,
  findEventAuthorityPda,
  findIntentPda,
  findMandatePda,
  findUserStatePda,
  findVaultPda,
  getAcceptAdminDiscriminatorBytes,
  getAdvanceEpochDiscriminatorBytes,
  getAdvanceNonceDiscriminatorBytes,
  getAdvanceNonceInstructionDataEncoder,
  getCancelIntentDiscriminatorBytes,
  getCloseIntentDiscriminatorBytes,
  getCreateIntentByAgentDiscriminatorBytes,
  getCreateMandateDiscriminatorBytes,
  getRevokeMandateDiscriminatorBytes,
  getCreateIntentDiscriminatorBytes,
  getCreateIntentInstructionDataEncoder,
  getExpireIntentDiscriminatorBytes,
  getFillIntentDiscriminatorBytes,
  getFillIntentInstructionDataEncoder,
  getInitConfigDiscriminatorBytes,
  getInitUserDiscriminatorBytes,
  getProposeAdminDiscriminatorBytes,
  getRaisePauseDiscriminatorBytes,
  getRaisePauseInstructionDataEncoder,
  getUpdateConfigDiscriminatorBytes,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  IntentCoreError,
  type CoreErrorCode,
  checkFlags,
  partnerOf,
  splitFees,
  nextFreeNonce,
  CONFIG_VERSION,
  PAUSE_CREATE,
  PAUSE_FILL,
  INTENT_VERSION,
  USER_VERSION,
  validateExt,
  type IntentParams,
  requiredOut,
  attestedFillMessage,
  attestedFillPreimage,
  EVENT_IX_TAG,
  buildEd25519Instruction,
  checkAttested,
  ED25519_PROGRAM_ADDRESS,
  fitsExpiry,
  offchainEnvelope,
  signedIntentMessage,
  signedIntentPreimage,
  kindBit,
  ALL_KINDS_MASK,
  Kind,
  mulDivCeil,
  mulDivFloor,
  splitFee,
  I64_MAX,
  I64_MIN,
  U64_MAX,
  MAX_CRANK_BOUNTY,
  MAX_CREATE_FEE,
  MAX_EPOCH_JUMP,
  MAX_NONCE_JUMP,
  NONCE_CEILING,
  nextEpoch,
} from "../src/index.js";

type Outcome = { ok?: string; err?: string; fee?: string; net?: string };
type Vectors = {
  program: string;
  keys: Record<"owner" | "input_mint" | "output_mint" | "fee_recipient", string>;
  pdas: { name: string; address: string; owner?: string; nonce?: string; vault?: string; agent?: string; id?: string }[];
  atas: { owner: string; mint: string; token_program: string; address: string }[];
  params: { name: string; kind: string; hex: string; escrow: string }[];
  decode: { kind: string; hex: string; result: Outcome }[];
  required_out: { name: string; amount_in: string; now: string; result: Outcome }[];
  split_fee: { amount: string; bps: string; result: Outcome }[];
  mul_div: { a: string; b: string; d: string; floor: Outcome; ceil: Outcome }[];
  kind_bits: Record<"1" | "2" | "3" | "4" | "all", string>;
  attested_checks: { amount_in: string; result: string; outcome: Outcome }[];
  sig: Record<
    | "domain"
    | "receiver"
    | "owner_input"
    | "submit_by"
    | "relayer_fee"
    | "nonce"
    | "expires_at"
    | "kind"
    | "params"
    | "preimage"
    | "digest"
    | "envelope"
    | "ed25519_program"
    | "ed25519_ix_data_with_ab_signature"
    | "attest_intent"
    | "attest_payee"
    | "attest_result"
    | "attest_amount_in"
    | "attestor"
    | "attest_preimage"
    | "attest_message"
    | "attest_filled"
    | "attest_revision"
    | "attest_max_fee_bps"
    | "flags"
    | "epoch"
    | "ext",
    string
  >;
  fits_expiry: { name: string; expires_at: string; fits: boolean }[];
  instruction_data: { name: string; hex: string }[];
  discriminators: Record<string, string>;
  economics_caps: { create_fee: number; crank_bounty: number };
  jump_caps: { nonce: string; epoch: string; nonce_ceiling: string };
  random_dutch: {
    amount_in: string;
    start_out: string;
    end_out: string;
    start_ts: string;
    end_ts: string;
    asked: string;
    now: string;
    result: Outcome;
  }[];
  random_signed: {
    domain: string;
    owner: string;
    owner_input: string;
    input_mint: string;
    output_mint: string;
    receiver: string;
    nonce: string;
    expires_at: string;
    submit_by: string;
    kind: number;
    flags: number;
    params: string;
    epoch: string;
    ext: string;
    relayer_fee: string;
    preimage: string;
    digest: string;
    envelope: string;
  }[];
};

const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./golden/vectors.json", import.meta.url)),
    "utf8",
  ),
) as Vectors;

const bytes = (hex: string) => new Uint8Array(getBase16Encoder().encode(hex));
const hexOf = (b: ArrayLike<number>) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const addr = (s: string) => s as Address;

function settle<T>(f: () => T): { ok: T } | { err: string } {
  try {
    return { ok: f() };
  } catch (e) {
    if (e instanceof IntentCoreError) {
      return { err: e.code };
    }
    throw e;
  }
}

function named(name: string): IntentParams {
  const entry = vectors.params.find((p) => p.name === name);
  if (!entry) {
    throw new Error(`no golden params named ${name}`);
  }
  return decodeParams(Number(entry.kind), bytes(entry.hex));
}

describe("golden vectors emitted by the Rust implementation", () => {
  it("name the deployed program", () => {
    expect(INTENT_ENGINE_PROGRAM_ADDRESS).toBe(vectors.program);
  });

  it("mirror the program's caps on the create fee and crank bounty", () => {
    expect([MAX_CREATE_FEE, MAX_CRANK_BOUNTY]).toEqual([
      vectors.economics_caps.create_fee,
      vectors.economics_caps.crank_bounty,
    ]);
  });

  it("mirror the program's bounds on how far one advance may move the nonce base and the epoch", () => {
    expect([MAX_NONCE_JUMP, MAX_EPOCH_JUMP, NONCE_CEILING].map(String)).toEqual([
      vectors.jump_caps.nonce,
      vectors.jump_caps.epoch,
      vectors.jump_caps.nonce_ceiling,
    ]);
    for (const current of [0n, 5n, U64_MAX - MAX_EPOCH_JUMP - 1n]) {
      for (const fill of [0, 255]) {
        const next = nextEpoch(current, new Uint8Array(6).fill(fill));
        expect(next > current && next - current <= MAX_EPOCH_JUMP).toBe(true);
      }
    }
  });

  it("price hundreds of random dutch auctions exactly like the program", () => {
    expect(vectors.random_dutch).toHaveLength(200);
    for (const c of vectors.random_dutch) {
      const intent = {
        kind: Kind.DutchAuction,
        amountIn: BigInt(c.amount_in),
        startOut: BigInt(c.start_out),
        endOut: BigInt(c.end_out),
        startTs: BigInt(c.start_ts),
        endTs: BigInt(c.end_ts),
      } as const;
      const run = () => requiredOut(intent, BigInt(c.asked), BigInt(c.now)).toString();
      if (c.result.err === undefined) {
        expect(run(), JSON.stringify(c)).toBe(c.result.ok);
      } else {
        expect(run, JSON.stringify(c)).toThrow(new IntentCoreError(c.result.err as CoreErrorCode));
      }
    }
  });

  it("derive every program address the same way", async () => {
    for (const pda of vectors.pdas) {
      const derived = await (async () => {
        switch (pda.name) {
          case "config":
            return (await findConfigPda())[0];
          case "user":
            return (await findUserStatePda({ owner: addr(pda.owner ?? "") }))[0];
          case "event_authority":
            return (await findEventAuthorityPda())[0];
          case "mandate":
            return (
              await findMandatePda({ owner: addr(pda.owner ?? ""), agent: addr(pda.agent ?? ""), id: BigInt(pda.id ?? "") })
            )[0];
          case "intent": {
            const [intent] = await findIntentPda({
              owner: addr(pda.owner ?? ""),
              nonce: BigInt(pda.nonce ?? ""),
            });
            expect((await findVaultPda({ intent }))[0]).toBe(pda.vault);
            return intent;
          }
          default:
            throw new Error(`unexpected pda ${pda.name}`);
        }
      })();
      expect(derived, pda.name).toBe(pda.address);
    }
  });

  it("derive canonical token accounts for both token programs", async () => {
    for (const ata of vectors.atas) {
      expect(
        await findAssociatedTokenAddress({
          owner: addr(ata.owner),
          mint: addr(ata.mint),
          tokenProgram: addr(ata.token_program),
        }),
      ).toBe(ata.address);
    }
  });

  it("encode every kind's params byte for byte and agree on the escrow", () => {
    for (const p of vectors.params) {
      const intent = decodeParams(Number(p.kind), bytes(p.hex));
      expect(hexOf(encodeParams(intent)), p.name).toBe(p.hex);
      expect(escrowAmount(intent), p.name).toBe(BigInt(p.escrow));
    }
  });

  it("accept and reject exactly the params the program does", () => {
    for (const d of vectors.decode) {
      const got = settle(() => hexOf(encodeParams(decodeParams(Number(d.kind), bytes(d.hex)))));
      expect(got, `${d.kind}:${d.hex.slice(0, 40)}`).toEqual(d.result);
    }
  });

  it("price every sample to the same required output", () => {
    for (const r of vectors.required_out) {
      const intent = named(r.name);
      const got = settle(() =>
        requiredOut(intent, BigInt(r.amount_in), BigInt(r.now)).toString(),
      );
      expect(got, `${r.name} ${r.amount_in} @ ${r.now}`).toEqual(r.result);
    }
  });

  it("split fees identically, including the over-full rate", () => {
    for (const f of vectors.split_fee) {
      const got = settle(() => {
        const s = splitFee(BigInt(f.amount), Number(f.bps));
        return { fee: s.fee.toString(), net: s.net.toString() };
      });
      const want = f.result.err ? { err: f.result.err } : { ok: f.result };
      expect(got, `${f.amount} @ ${f.bps}`).toEqual(want);
    }
  });

  it("multiply and divide with the same rounding and overflow edges", () => {
    expect(U64_MAX).toBe(18_446_744_073_709_551_615n);
    for (const m of vectors.mul_div) {
      const [a, b, d] = [BigInt(m.a), BigInt(m.b), BigInt(m.d)];
      expect(settle(() => mulDivFloor(a, b, d).toString()), `floor ${m.a}*${m.b}/${m.d}`).toEqual(
        m.floor,
      );
      expect(settle(() => mulDivCeil(a, b, d).toString()), `ceil ${m.a}*${m.b}/${m.d}`).toEqual(
        m.ceil,
      );
    }
  });

  it("use the same kind bits and enabled-kinds mask", () => {
    expect(kindBit(Kind.SwapExactIn)).toBe(BigInt(vectors.kind_bits["1"]));
    expect(kindBit(Kind.LimitOrder)).toBe(BigInt(vectors.kind_bits["2"]));
    expect(kindBit(Kind.DutchAuction)).toBe(BigInt(vectors.kind_bits["3"]));
    expect(kindBit(Kind.AttestedResult)).toBe(BigInt(vectors.kind_bits["4"]));
    expect(ALL_KINDS_MASK).toBe(BigInt(vectors.kind_bits.all));
  });

  it("agree on whether an auction finishes by its expiry", () => {
    for (const f of vectors.fits_expiry) {
      expect(fitsExpiry(named(f.name), BigInt(f.expires_at)), `${f.name} @ ${f.expires_at}`).toBe(
        f.fits,
      );
    }
  });

  it("bound attested results identically and return the signed attestor", () => {
    const attested = named("attested");
    for (const c of vectors.attested_checks) {
      const got = settle(() =>
        hexOf(getAddressEncoder().encode(checkAttested(attested, BigInt(c.amount_in), BigInt(c.result)))),
      );
      expect(got, `${c.amount_in} -> ${c.result}`).toEqual(c.outcome);
    }
  });

  it("build the same preimage, digest and envelope as Rust for random raw signed fields", async () => {
    expect(vectors.random_signed).toHaveLength(64);
    for (const [i, v] of vectors.random_signed.entries()) {
      const preimage = await signedIntentPreimage({
        domain: bytes(v.domain),
        owner: addr(v.owner),
        ownerInput: addr(v.owner_input),
        inputMint: addr(v.input_mint),
        outputMint: addr(v.output_mint),
        receiver: addr(v.receiver),
        nonce: BigInt(v.nonce),
        expiresAt: BigInt(v.expires_at),
        submitBy: BigInt(v.submit_by),
        kind: v.kind,
        flags: v.flags,
        params: bytes(v.params),
        epoch: BigInt(v.epoch),
        ext: bytes(v.ext),
        relayerFee: BigInt(v.relayer_fee),
      });
      expect(hexOf(preimage), `vector ${i}`).toBe(v.preimage);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", preimage.slice()));
      expect(hexOf(digest), `vector ${i}`).toBe(v.digest);
      expect(hexOf(offchainEnvelope(addr(v.owner), digest)), `vector ${i}`).toBe(v.envelope);
    }
  });

  it("build the signed-intent preimage, digest and wallet envelope byte for byte", async () => {
    const s = vectors.sig;
    const fields = {
      domain: bytes(s.domain),
      owner: vectors.keys.owner as Address,
      inputMint: vectors.keys.input_mint as Address,
      outputMint: vectors.keys.output_mint as Address,
      receiver: s.receiver as Address,
      ownerInput: s.owner_input as Address,
      nonce: BigInt(s.nonce),
      expiresAt: BigInt(s.expires_at),
      submitBy: BigInt(s.submit_by),
      kind: Number(s.kind),
      params: bytes(s.params),
      flags: Number(s.flags),
      epoch: BigInt(s.epoch),
      relayerFee: BigInt(s.relayer_fee),
      ext: bytes(s.ext),
    };
    const preimage = await signedIntentPreimage(fields);
    expect(hexOf(preimage)).toBe(s.preimage);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", preimage.slice()));
    expect(hexOf(digest)).toBe(s.digest);
    expect(hexOf(offchainEnvelope(fields.owner, digest))).toBe(s.envelope);
    await expect(signedIntentMessage(fields)).rejects.toThrow(new IntentCoreError("FlagsUnknown"));
    await expect(signedIntentMessage({ ...fields, flags: 0 })).rejects.toThrow(new IntentCoreError("ExtMalformed"));
    const plain = { ...fields, flags: 0, ext: new Uint8Array() };
    const plainDigest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", (await signedIntentPreimage(plain)).slice()),
    );
    expect(hexOf(await signedIntentMessage(plain))).toBe(hexOf(offchainEnvelope(fields.owner, plainDigest)));
    const viaKit = getOffchainMessageV1Encoder().encode({
      version: 1,
      requiredSignatories: [{ address: fields.owner }],
      content: hexOf(digest),
    });
    expect(hexOf(viaKit)).toBe(s.envelope);
  });

  it("tag events and name them exactly as the Rust program does", () => {
    const v = vectors as unknown as { event_ix_tag: string; event_discriminators: Record<string, string> };
    expect(hexOf(EVENT_IX_TAG)).toBe(v.event_ix_tag);
    const lookup = core as unknown as Record<string, Uint8Array>;
    const names = Object.keys(v.event_discriminators);
    expect(names).toEqual(Object.keys(core.IntentEngineEvent).filter((k) => Number.isNaN(Number(k))).sort());
    for (const name of names) {
      const screaming = name.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
      expect(hexOf(lookup[`${screaming}_EVENT_DISCRIMINATOR`] ?? []), name).toBe(v.event_discriminators[name]);
    }
  });

  it("refuse to sign values the program would read differently", async () => {
    const s = vectors.sig;
    const fields = {
      domain: bytes(s.domain),
      owner: vectors.keys.owner as Address,
      inputMint: vectors.keys.input_mint as Address,
      outputMint: vectors.keys.output_mint as Address,
      receiver: s.receiver as Address,
      ownerInput: s.owner_input as Address,
      nonce: BigInt(s.nonce),
      expiresAt: BigInt(s.expires_at),
      submitBy: BigInt(s.submit_by),
      kind: Number(s.kind),
      params: bytes(s.params),
      flags: Number(s.flags),
      epoch: BigInt(s.epoch),
      relayerFee: BigInt(s.relayer_fee),
      ext: bytes(s.ext),
    };
    const ok = (over: Partial<typeof fields>) => signedIntentPreimage({ ...fields, ...over });
    for (const over of [
      { nonce: 0n },
      { nonce: U64_MAX },
      { expiresAt: I64_MIN },
      { expiresAt: I64_MAX },
      { submitBy: I64_MIN },
      { submitBy: I64_MAX },
      { kind: 0 },
      { kind: 255 },
      { flags: 0 },
      { flags: 0xffff },
      { epoch: 0n },
      { epoch: U64_MAX },
      { relayerFee: 0n },
      { relayerFee: U64_MAX },
      { ext: new Uint8Array(512) },
    ]) {
      await expect(ok(over), JSON.stringify(over, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v))).resolves.toHaveLength(448);
    }
    await expect(ok({ nonce: -1n })).rejects.toThrow("-1 is outside u64");
    await expect(ok({ nonce: U64_MAX + 1n })).rejects.toThrow(`${U64_MAX + 1n} is outside u64`);
    await expect(ok({ expiresAt: I64_MIN - 1n })).rejects.toThrow(`${I64_MIN - 1n} is outside i64`);
    await expect(ok({ expiresAt: I64_MAX + 1n })).rejects.toThrow(RangeError);
    await expect(ok({ submitBy: I64_MAX + 1n })).rejects.toThrow(RangeError);
    await expect(ok({ submitBy: I64_MIN - 1n })).rejects.toThrow(RangeError);
    await expect(ok({ kind: 256 })).rejects.toThrow("256 is not a kind byte");
    await expect(ok({ kind: -1 })).rejects.toThrow(RangeError);
    await expect(ok({ kind: 1.5 })).rejects.toThrow(RangeError);
    await expect(ok({ flags: 0x10000 })).rejects.toThrow("65536 is not a u16 flag set");
    await expect(ok({ flags: -1 })).rejects.toThrow(RangeError);
    await expect(ok({ epoch: -1n })).rejects.toThrow(RangeError);
    await expect(ok({ epoch: U64_MAX + 1n })).rejects.toThrow(RangeError);
    await expect(ok({ ext: new Uint8Array(513) })).rejects.toThrow("ext must be at most 512 bytes");
    const attest = {
      domain: bytes(s.domain),
      intent: vectors.keys.owner as Address,
      payee: vectors.keys.owner as Address,
      amountIn: 1n,
      result: 1n,
      maxFeeBps: 0,
    };
    await expect(attestedFillPreimage({ ...attest, amountIn: U64_MAX, result: 0n })).resolves.toHaveLength(206);
    await expect(attestedFillPreimage({ ...attest, maxFeeBps: 0xffff })).resolves.toHaveLength(206);
    await expect(attestedFillPreimage({ ...attest, maxFeeBps: 0x1_0000 })).rejects.toThrow("65536 is outside u16");
    await expect(attestedFillPreimage({ ...attest, maxFeeBps: -1 })).rejects.toThrow(RangeError);
    await expect(attestedFillPreimage({ ...attest, maxFeeBps: 0.5 })).rejects.toThrow(RangeError);
    await expect(attestedFillPreimage({ ...attest, amountIn: -1n })).rejects.toThrow(RangeError);
    await expect(attestedFillPreimage({ ...attest, result: U64_MAX + 1n })).rejects.toThrow(RangeError);
    await expect(attestedFillPreimage({ ...attest, filled: U64_MAX, revision: 0xffff_ffff })).resolves.toHaveLength(206);
    await expect(attestedFillPreimage({ ...attest, filled: -1n })).rejects.toThrow(RangeError);
    await expect(attestedFillPreimage({ ...attest, revision: 0x1_0000_0000 })).rejects.toThrow("4294967296 is outside u32");
    await expect(attestedFillPreimage({ ...attest, revision: -1 })).rejects.toThrow(RangeError);
    await expect(attestedFillPreimage({ ...attest, revision: 0.5 })).rejects.toThrow(RangeError);
    await expect(attestedFillPreimage({ ...attest, ext: new Uint8Array(512) })).resolves.toHaveLength(206);
    await expect(attestedFillPreimage({ ...attest, ext: new Uint8Array(513) })).rejects.toThrow(
      "ext must be at most 512 bytes",
    );
  });

  it("refuse a preimage whose domain or params have the wrong length", async () => {
    const s = vectors.sig;
    const fields = {
      domain: bytes(s.domain),
      owner: vectors.keys.owner as Address,
      inputMint: vectors.keys.input_mint as Address,
      outputMint: vectors.keys.output_mint as Address,
      receiver: s.receiver as Address,
      ownerInput: s.owner_input as Address,
      nonce: BigInt(s.nonce),
      expiresAt: BigInt(s.expires_at),
      submitBy: BigInt(s.submit_by),
      kind: Number(s.kind),
      params: bytes(s.params),
      flags: Number(s.flags),
      epoch: BigInt(s.epoch),
      relayerFee: BigInt(s.relayer_fee),
      ext: bytes(s.ext),
    };
    const message = "domain must be 32 bytes and params 128 bytes";
    await expect(signedIntentPreimage({ ...fields, domain: fields.domain.subarray(1) })).rejects.toThrow(message);
    await expect(signedIntentPreimage({ ...fields, params: fields.params.subarray(1) })).rejects.toThrow(message);
    await expect(signedIntentPreimage(fields)).resolves.toHaveLength(448);
  });

  it("lay out the Ed25519 instruction exactly as the official builder does", () => {
    const ix = buildEd25519Instruction({
      publicKey: vectors.keys.owner as Address,
      signature: new Uint8Array(64).fill(0xab),
      message: bytes(vectors.sig.envelope),
    });
    expect(ix.programAddress).toBe(vectors.sig.ed25519_program);
    expect(ED25519_PROGRAM_ADDRESS).toBe(vectors.sig.ed25519_program);
    expect(hexOf(ix.data ?? [])).toBe(vectors.sig.ed25519_ix_data_with_ab_signature);
  });

  it("bind attestations to program, domain, intent, payee, amount, result, fill state and extensions", async () => {
    const s = vectors.sig;
    const fields = {
      domain: bytes(s.domain),
      intent: s.attest_intent as Address,
      payee: s.attest_payee as Address,
      amountIn: BigInt(s.attest_amount_in),
      result: BigInt(s.attest_result),
      filled: BigInt(s.attest_filled),
      revision: Number(s.attest_revision),
      maxFeeBps: Number(s.attest_max_fee_bps),
      ext: bytes(s.ext),
    };
    const preimage = await attestedFillPreimage(fields);
    expect(hexOf(preimage)).toBe(s.attest_preimage);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", preimage.slice()));
    expect(hexOf(offchainEnvelope(s.attestor as Address, digest))).toBe(s.attest_message);
    await expect(attestedFillMessage(s.attestor as Address, fields)).rejects.toThrow(
      new IntentCoreError("ExtUnknown"),
    );
    const plain = { ...fields, ext: new Uint8Array() };
    const plainDigest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", (await attestedFillPreimage(plain)).slice()),
    );
    expect(hexOf(await attestedFillMessage(s.attestor as Address, plain))).toBe(
      hexOf(offchainEnvelope(s.attestor as Address, plainDigest)),
    );
  });

  it("carry the account versions the program accepts", () => {
    const v = vectors as unknown as { versions: Record<"config" | "user" | "intent", number> };
    expect({ config: CONFIG_VERSION, user: USER_VERSION, intent: INTENT_VERSION }).toEqual(v.versions);
    const p = vectors as unknown as { pause: Record<"create" | "fill", number> };
    expect({ create: PAUSE_CREATE, fill: PAUSE_FILL }).toEqual(p.pause);
  });

  it("pick the next free nonce exactly as the program does", () => {
    const v = vectors as unknown as { next_free_nonce: { base: string; bits: string[]; next: string | null }[] };
    expect(v.next_free_nonce.length).toBeGreaterThan(8);
    for (const c of v.next_free_nonce) {
      const window = { nonceBase: BigInt(c.base), nonceBitmap: c.bits.map(BigInt) };
      expect(nextFreeNonce(window), JSON.stringify(c)).toBe(c.next === null ? null : BigInt(c.next));
    }
    expect(() => nextFreeNonce({ nonceBase: 0n, nonceBitmap: [0n, 0n, 0n] })).toThrow(
      "a nonce window has 4 words, got 3",
    );
  });

  it("split fees and read partners exactly as the program does", () => {
    const v = vectors as unknown as {
      split_fees: {
        amount: string;
        fee_bps: string;
        partner_bps: string;
        cut_bps: string;
        result: { protocol?: string; partner?: string; net?: string; err?: string };
      }[];
      partner_checks: { hex: string; outcome: { ok?: { key: string; bps: number } | null; err?: string } }[];
    };
    expect(v.split_fees.length).toBeGreaterThan(8);
    for (const c of v.split_fees) {
      const run = () => splitFees(BigInt(c.amount), Number(c.fee_bps), Number(c.partner_bps), Number(c.cut_bps));
      if (c.result.err === undefined) {
        expect(run(), c.amount).toEqual({
          protocol: BigInt(c.result.protocol ?? ""),
          partner: BigInt(c.result.partner ?? ""),
          net: BigInt(c.result.net ?? ""),
        });
      } else {
        expect(run, c.amount).toThrow(new IntentCoreError(c.result.err as CoreErrorCode));
      }
    }
    expect(v.partner_checks.length).toBeGreaterThan(8);
    for (const c of v.partner_checks) {
      const run = () => partnerOf(bytes(c.hex));
      if (c.outcome.err === undefined) {
        expect(run(), c.hex).toEqual(c.outcome.ok === null ? undefined : c.outcome.ok);
      } else {
        expect(run, c.hex).toThrow(new IntentCoreError(c.outcome.err as CoreErrorCode));
      }
    }
  });

  it("validate extensions and flags exactly as the program does", () => {
    const v = vectors as unknown as {
      ext_checks: { hex: string; known: number[]; outcome: { ok?: string; err?: string } }[];
      flag_checks: { flags: number; outcome: { ok?: string; err?: string } }[];
    };
    expect(v.ext_checks.length).toBeGreaterThan(10);
    for (const c of v.ext_checks) {
      const run = () => validateExt(bytes(c.hex), c.known);
      if (c.outcome.err === undefined) {
        expect(run, c.hex).not.toThrow();
      } else {
        expect(run, c.hex).toThrow(new IntentCoreError(c.outcome.err as CoreErrorCode));
      }
    }
    for (const c of v.flag_checks) {
      const run = () => checkFlags(c.flags);
      if (c.outcome.err === undefined) {
        expect(run(), String(c.flags)).toBe(c.flags);
      } else {
        expect(run, String(c.flags)).toThrow(new IntentCoreError(c.outcome.err as CoreErrorCode));
      }
    }
  });

  it("serialize instruction data the program expects", () => {
    const want = Object.fromEntries(vectors.instruction_data.map((d) => [d.name, d.hex]));
    const swap = vectors.decode[0];
    expect(swap).toBeDefined();
    expect(
      hexOf(
        getCreateIntentInstructionDataEncoder().encode({
          args: {
            nonce: 42n,
            kind: 1,
            flags: 3,
            params: bytes(swap?.hex ?? ""),
            expiresAt: 1_700_000_000n,
            ext: bytes("010200aabb"),
            maxCreateFee: 0x0102_0304,
            maxBounty: 0x0506_0708,
          },
        }),
      ),
    ).toBe(want["create_intent"]);
    expect(
      hexOf(
        getFillIntentInstructionDataEncoder().encode({
          amountIn: 1_000_000n,
          amountOut: 990_000n,
          maxFeeBps: 100,
          ext: bytes("010200aabb"),
        }),
      ),
    ).toBe(want["fill_intent"]);
    expect(hexOf(getAdvanceNonceInstructionDataEncoder().encode({ nonceBase: 300n }))).toBe(
      want["advance_nonce"],
    );
    expect(hexOf(getRaisePauseInstructionDataEncoder().encode({ flags: 1 }))).toBe(
      want["raise_pause"],
    );
  });

  it("agree on every instruction discriminator", () => {
    const ours: Record<string, ArrayLike<number>> = {
      init_config: getInitConfigDiscriminatorBytes(),
      update_config: getUpdateConfigDiscriminatorBytes(),
      propose_admin: getProposeAdminDiscriminatorBytes(),
      accept_admin: getAcceptAdminDiscriminatorBytes(),
      raise_pause: getRaisePauseDiscriminatorBytes(),
      init_user: getInitUserDiscriminatorBytes(),
      advance_nonce: getAdvanceNonceDiscriminatorBytes(),
      advance_epoch: getAdvanceEpochDiscriminatorBytes(),
      create_intent: getCreateIntentDiscriminatorBytes(),
      fill_intent: getFillIntentDiscriminatorBytes(),
      cancel_intent: getCancelIntentDiscriminatorBytes(),
      expire_intent: getExpireIntentDiscriminatorBytes(),
      close_intent: getCloseIntentDiscriminatorBytes(),
      create_mandate: getCreateMandateDiscriminatorBytes(),
      revoke_mandate: getRevokeMandateDiscriminatorBytes(),
      create_intent_by_agent: getCreateIntentByAgentDiscriminatorBytes(),
    };
    expect(Object.keys(ours).sort()).toEqual(Object.keys(vectors.discriminators).sort());
    for (const [name, disc] of Object.entries(ours)) {
      expect(hexOf(disc), name).toBe(vectors.discriminators[name]);
    }
  });
});
