import { readFileSync } from "node:fs";
import * as core from "../src/internal.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddressEncoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, IntentCoreError, type CoreErrorCode, Kind } from "../src/index.js";
import {
  decodeParams,
  encodeParams,
  escrowAmount,
  findConfigPda,
  findEventAuthorityPda,
  findIntentPda,
  findMandatePda,
  findUserStatePda,
  findVaultPda,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  requiredOut,
  checkAttested,
  fitsExpiry,
  kindBit,
  ALL_KINDS_MASK,
  mulDivCeil,
  mulDivFloor,
  splitFee,
  U64_MAX,
  MAX_CRANK_BOUNTY,
  MAX_CREATE_FEE,
  MAX_EPOCH_JUMP,
  MAX_NONCE_JUMP,
  NONCE_CEILING,
  nextEpoch,
} from "../src/internal.js";
import { addr, bytes, hexOf, named, settle, vectors } from "./golden-vectors.js";

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
});

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));

describe("error codes", () => {
  it("error codes cover every mandate error", () => {
    const source = readFileSync(join(ROOT, "crates/intent-core/src/error.rs"), "utf8");
    const body = /pub enum Error \{([^}]*)\}/.exec(source)?.[1] ?? "";
    const rust = Array.from(body.matchAll(/^\s*([A-Z]\w*),?\s*$/gm), (m) => m[1]);
    const mandate = rust.filter((name) => name?.startsWith("Mandate"));
    expect(mandate).toEqual(["MandateInvalid", "MandateExpired", "MandateKind", "MandateTtl", "MandateCap", "MandateBudget", "MandateCount", "MandatePrice"]);
    expect([...core.CORE_ERROR_CODES]).toEqual(rust);
    for (const code of core.CORE_ERROR_CODES) {
      expect(new core.IntentCoreError(code).engineError).toBe(code);
    }
  });
});
