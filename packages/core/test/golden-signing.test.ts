import * as core from "../src/internal.js";
import { type Address, getOffchainMessageV1Encoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { IntentCoreError } from "../src/index.js";
import {
  attestedFillMessage,
  attestedFillPreimage,
  attestedDeliveryPreimage,
  SPLIT_COSIGN_TAG,
  attestedSplitDeliveryPreimage,
  buildEd25519CosignInstruction,
  splitCosignEnvelope,
  splitCommit,
  splitN,
  EVENT_IX_TAG,
  buildEd25519Instruction,
  ED25519_PROGRAM_ADDRESS,
  offchainEnvelope,
  signedIntentMessage,
  signedIntentPreimage,
  I64_MAX,
  I64_MIN,
  U64_MAX,
} from "../src/internal.js";
import { InvalidInput } from "../src/errors.js";
import { addr, bytes, hexOf, vectors } from "./golden-vectors.js";

describe("golden vectors emitted by the Rust implementation", () => {
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

  it("tag events and name them exactly as the Rust program does", async () => {
    const v = vectors as unknown as { event_ix_tag: string; event_discriminators: Record<string, string> };
    expect(hexOf(EVENT_IX_TAG)).toBe(v.event_ix_tag);
    const lookup = core as unknown as Record<string, Uint8Array>;
    const discriminatorOf = (name: string) => hexOf(lookup[`${name.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}_EVENT_DISCRIMINATOR`] ?? []);
    const names = Object.keys(v.event_discriminators);
    const generated = Object.keys(core.IntentEngineEvent).filter((k) => Number.isNaN(Number(k)));
    for (const name of names) {
      expect(generated, name).toContain(name);
      expect(discriminatorOf(name), name).toBe(v.event_discriminators[name]);
    }
    const unlisted = generated.filter((name) => !names.includes(name)).sort();
    expect(unlisted).toEqual(["AnnounceFeeSet", "AnnouncementClosed", "CommitteeKeysSynced", "DeliveryAnnounced", "DeliveryBookClosed", "DeliveryReleased", "HeldShareClaimed", "ReleaseRefuted", "ShareHeld"]);
    for (const name of unlisted) {
      const anchor = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`event:${name}`))).subarray(0, 8);
      expect(discriminatorOf(name), name).toBe(hexOf(anchor));
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
    await expect(ok({ expiresAt: I64_MAX + 1n })).rejects.toThrow(InvalidInput);
    await expect(ok({ submitBy: I64_MAX + 1n })).rejects.toThrow(InvalidInput);
    await expect(ok({ submitBy: I64_MIN - 1n })).rejects.toThrow(InvalidInput);
    await expect(ok({ kind: 256 })).rejects.toThrow("256 is not a kind byte");
    await expect(ok({ kind: -1 })).rejects.toThrow(InvalidInput);
    await expect(ok({ kind: 1.5 })).rejects.toThrow(InvalidInput);
    await expect(ok({ flags: 0x10000 })).rejects.toThrow("65536 is not a u16 flag set");
    await expect(ok({ flags: -1 })).rejects.toThrow(InvalidInput);
    await expect(ok({ epoch: -1n })).rejects.toThrow(InvalidInput);
    await expect(ok({ epoch: U64_MAX + 1n })).rejects.toThrow(InvalidInput);
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
    await expect(attestedFillPreimage({ ...attest, maxFeeBps: -1 })).rejects.toThrow(InvalidInput);
    await expect(attestedFillPreimage({ ...attest, maxFeeBps: 0.5 })).rejects.toThrow(InvalidInput);
    await expect(attestedFillPreimage({ ...attest, amountIn: -1n })).rejects.toThrow(InvalidInput);
    await expect(attestedFillPreimage({ ...attest, result: U64_MAX + 1n })).rejects.toThrow(InvalidInput);
    await expect(attestedFillPreimage({ ...attest, filled: U64_MAX, revision: 0xffff_ffff })).resolves.toHaveLength(206);
    await expect(attestedFillPreimage({ ...attest, filled: -1n })).rejects.toThrow(InvalidInput);
    await expect(attestedFillPreimage({ ...attest, revision: 0x1_0000_0000 })).rejects.toThrow("4294967296 is outside u32");
    await expect(attestedFillPreimage({ ...attest, revision: -1 })).rejects.toThrow(InvalidInput);
    await expect(attestedFillPreimage({ ...attest, revision: 0.5 })).rejects.toThrow(InvalidInput);
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

  it("bind delivery attestations to the spec hash, announcement, seq and opening like Rust", async () => {
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
      extHash: new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(s.ext).slice())),
      specHash: bytes(s.attest_spec_hash),
      announcement: s.attest_announcement as Address,
      seq: BigInt(s.attest_seq),
      delivered: bytes(s.attest_delivered),
      salt: bytes(s.attest_salt),
    };
    const preimage = attestedDeliveryPreimage(fields);
    expect(preimage).toHaveLength(326);
    expect(hexOf(preimage)).toBe(s.attest_delivery_preimage);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", preimage.slice()));
    expect(hexOf(offchainEnvelope(s.attestor as Address, digest))).toBe(s.attest_delivery_message);
    for (const other of [
      { ...fields, specHash: new Uint8Array(32).fill(1) },
      { ...fields, seq: fields.seq + 1n },
      { ...fields, salt: new Uint8Array(16).fill(1) },
    ]) {
      expect(hexOf(attestedDeliveryPreimage(other))).not.toBe(s.attest_delivery_preimage);
    }
  });

  it("split an amount across weights exactly like the program's kernel", () => {
    for (const c of vectors.split_plans) {
      const shares = splitN(BigInt(c.amount), c.weights.map(Number));
      expect(shares.map(String)).toEqual(c.shares);
      const total = shares.reduce((a, b) => a + b, 0n);
      expect(total).toBe(BigInt(c.amount));
    }
  });

  it("commit a split to its recipients and weights byte for byte like Rust", async () => {
    for (const c of vectors.split_commits) {
      const commit = await splitCommit(
        c.recipients as Address[],
        c.weights.map(Number),
      );
      expect(hexOf(commit)).toBe(c.hash);
    }
  });

  it("bind split delivery attestations to the spec and split hashes, announcement, seq and opening like Rust", async () => {
    const s = vectors.sig;
    const fields = {
      domain: bytes(s.domain),
      intent: s.attest_intent as Address,
      amountIn: BigInt(s.attest_amount_in),
      result: BigInt(s.attest_result),
      filled: BigInt(s.attest_filled),
      revision: Number(s.attest_revision),
      maxFeeBps: Number(s.attest_max_fee_bps),
      extHash: new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(s.ext).slice())),
      specHash: bytes(s.attest_spec_hash),
      splitHash: bytes(s.attest_split_hash),
      announcement: s.attest_announcement as Address,
      seq: BigInt(s.attest_seq),
      delivered: bytes(s.attest_delivered),
      salt: bytes(s.attest_salt),
    };
    const preimage = attestedSplitDeliveryPreimage(fields);
    expect(preimage).toHaveLength(326);
    expect(hexOf(preimage)).toBe(s.attest_split_delivery_preimage);
    const tagged = new Uint8Array([...SPLIT_COSIGN_TAG, ...preimage]);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", tagged));
    const cosigners = (vectors.sig as unknown as { attest_split_cosigners: Address[] }).attest_split_cosigners;
    const message = splitCosignEnvelope(digest, cosigners);
    expect(hexOf(message)).toBe(s.attest_split_message);
    const viaKit = getOffchainMessageV1Encoder().encode({
      version: 1,
      requiredSignatories: cosigners.map((address) => ({ address })),
      content: hexOf(digest),
    });
    expect(hexOf(viaKit)).toBe(s.attest_split_message);
    const entries = cosigners.map((publicKey) => ({ publicKey, signature: new Uint8Array(64).fill(0xab) }));
    expect(hexOf(buildEd25519CosignInstruction({ entries, message }).data ?? new Uint8Array())).toBe(s.attest_split_batch_with_ab_signatures);
    const otherSplit = { ...fields, splitHash: new Uint8Array(32).fill(1) };
    expect(hexOf(attestedSplitDeliveryPreimage(otherSplit))).not.toBe(s.attest_split_delivery_preimage);
  });
});
