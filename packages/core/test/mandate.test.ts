import { type Address, getBase58Decoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  describeMandate,
  getCreateMandateInstructionDataEncoder,
  LONG_MANDATE_SECONDS,
  MANDATE_KINDS,
  inLane,
  MANDATE_NONCE_BIT,
  mandateLane,
  type MandateSpec,
  mandateArgs,
  mandateKinds,
  NO_PARTNER,
  WARN_LONG_MANDATE,
} from "../src/index.js";
import vectors from "./golden/vectors.json" with { type: "json" };

const AGENT = "11111111111111111111111111111112" as Address;
const PARTNER = "SysvarC1ock11111111111111111111111111111111" as Address;
const IN = "So11111111111111111111111111111111111111112" as Address;
const OUT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
const NOW = 1_700_000_000n;

const spec = (over: Partial<MandateSpec> = {}): MandateSpec => ({
  id: 7n,
  agent: AGENT,
  kinds: 0b1110,
  perIntent: 400n,
  total: 1_000n,
  maxIntents: 4,
  maxTtl: 3_600n,
  validUntil: NOW + 86_400n,
  floorOut: 3n,
  floorIn: 2n,
  ...over,
});

const filled = (byte: number) => getBase58Decoder().decode(new Uint8Array(32).fill(byte)) as Address;

const hexOf = (bytes: ArrayLike<number>) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

describe("mandates", () => {
  it("take nonces only from the top half, as the program does", () => {
    expect(MANDATE_NONCE_BIT.toString()).toBe((vectors as { mandate_nonce_bit: string }).mandate_nonce_bit);
    const lanes = (vectors as unknown as { mandate_lanes: { serial: string; lane: string | null }[] }).mandate_lanes;
    expect(lanes).toHaveLength(6);
    for (const { serial, lane } of lanes) {
      expect(mandateLane(BigInt(serial)), serial).toBe(lane === null ? null : BigInt(lane));
      if (lane !== null) {
        expect(inLane(BigInt(lane) | 0xffff_ffffn, BigInt(serial))).toBe(true);
        expect(inLane(BigInt(lane) | 5n, BigInt(serial) + 1n)).toBe(false);
        expect(inLane(BigInt(lane) & ~MANDATE_NONCE_BIT, BigInt(serial))).toBe(false);
      }
    }
    expect(inLane(MANDATE_NONCE_BIT, 0n)).toBe(false);
  });

  it("cover only swap, limit and dutch intents", () => {
    expect(MANDATE_KINDS).toBe(0b1110);
    expect(mandateKinds(0b1110)).toEqual(["swap", "limit", "dutch"]);
    expect(mandateKinds(0b0010)).toEqual(["swap"]);
    expect(mandateKinds(0b1000)).toEqual(["dutch"]);
    expect(mandateKinds(0b0100)).toEqual(["limit"]);
    for (const bad of [0, -2, 0b1_0000, 0b1_1110, 0b1, 1.5]) {
      expect(() => mandateKinds(bad), String(bad)).toThrow(
        `a mandate may cover only swap, limit and dutch intents, got kind bits ${bad}`,
      );
    }
  });

  it("encode exactly the instruction the program decodes", () => {
    const golden = (vectors as { instruction_data: { name: string; hex: string }[] }).instruction_data.find(
      (d) => d.name === "create_mandate",
    );
    const args = mandateArgs(
      spec({
        agent: filled(0x0a),
        validUntil: 1_700_086_400n,
        partner: { key: filled(0x0b), bps: 25 },
        agentFee: 9n,
      }),
    );
    expect(hexOf(getCreateMandateInstructionDataEncoder().encode(args))).toBe(golden?.hex);
  });

  it("send no partner as the zero key and refuse an invalid partner", () => {
    expect(NO_PARTNER).toBe("11111111111111111111111111111111");
    expect(mandateArgs(spec())).toMatchObject({ partner: NO_PARTNER, partnerBps: 0 });
    expect(mandateArgs(spec({ partner: { key: PARTNER, bps: 100 } }))).toMatchObject({ partner: PARTNER, partnerBps: 100 });
    expect(() => mandateArgs(spec({ partner: { key: PARTNER, bps: 101 } }))).toThrow("a partner share must be 1 to 100 bps");
    expect(() => mandateArgs(spec({ kinds: 0b1_0000 }))).toThrow(RangeError);
  });

  it("describe every limit the owner grants in plain words", () => {
    const d = describeMandate(spec({ partner: { key: PARTNER, bps: 25 } }), {
      inputMint: IN,
      outputMint: OUT,
      now: NOW,
      inputDecimals: 2,
      outputDecimals: 3,
    });
    expect(d).toEqual({
      warnings: [],
      lines: [
        `Agent: ${AGENT}`,
        `May sell: ${IN} for ${OUT} only, as swap, limit, dutch intents`,
        `Per intent: at most 4 of ${IN}`,
        `In total: at most 10 of ${IN} over at most 4 intents`,
        `Price floor: at least 0.003 of ${OUT} for every 0.02 of ${IN}`,
        "Each intent expires within 3600 seconds of its creation",
        `Valid until: ${new Date(Number(NOW + 86_400n) * 1000).toISOString()}`,
        `Partner fee: 25 bps of the sold amount to ${PARTNER}`,
        "Proceeds always go to your own token account; the agent pays all network fees and rent and takes no fee",
        "The agent's intents use their own nonces and never touch your signing window",
        "Revoke it any time, or revoke every mandate and signature at once by advancing your signing epoch; once revoked, no intent the agent opened can be filled, and you can cancel them to take your tokens back",
      ],
    });
    const named = describeMandate(spec({ agentFee: 5n }), { inputMint: IN, outputMint: OUT, now: NOW, inputDecimals: 2, inputName: "SOL", outputName: "USD" });
    expect(named.lines.filter((line) => line.includes(IN)).every((line) => line.includes(`SOL (${IN})`))).toBe(true);
    expect(named.lines.some((line) => line.includes(`of USD (${OUT}) for every`))).toBe(true);
    const paid = describeMandate(spec({ agentFee: 5n }), { inputMint: IN, outputMint: OUT, now: NOW, inputDecimals: 2 });
    expect(paid.lines.filter((line) => /not refunded|paid as each intent is created/.test(line))).toEqual([]);
    expect(paid.lines.slice(7, 10)).toEqual([
      `Agent fee: 0.05 of ${IN} per intent, paid to the agent only when that intent fills (refunded if it is cancelled or expires) and counted in every limit above, the price floor included`,
      `Largest single sale: 3.95 of ${IN}, the per-intent cap less the agent fee`,
      "Proceeds always go to your own token account; the agent pays all network fees and rent",
    ]);
    expect(() => describeMandate(spec({ perIntent: 5n, agentFee: 5n }), { inputMint: IN, outputMint: OUT, now: NOW })).toThrow(
      "an agent fee of 5 leaves nothing to sell under a per-intent cap of 5",
    );
    expect(() => describeMandate(spec({ perIntent: 5n, agentFee: 6n }), { inputMint: IN, outputMint: OUT, now: NOW })).toThrow(
      RangeError,
    );
    const thin = describeMandate(spec({ perIntent: 6n, agentFee: 5n }), { inputMint: IN, outputMint: OUT, now: NOW });
    expect(thin.lines[8]).toBe(`Largest single sale: 1 raw units of ${IN}, the per-intent cap less the agent fee`);
    expect(mandateArgs(spec({ agentFee: 5n })).agentFee).toBe(5n);
    expect(mandateArgs(spec({})).agentFee).toBe(0n);
    expect(LONG_MANDATE_SECONDS).toBe(2_592_000n);
    const edge = describeMandate(spec({ validUntil: NOW + LONG_MANDATE_SECONDS }), { inputMint: IN, outputMint: OUT, now: NOW });
    expect(edge.warnings).toEqual([]);
    expect(edge.lines[2]).toBe(`Per intent: at most 400 raw units of ${IN}`);
    const long = describeMandate(spec({ validUntil: NOW + LONG_MANDATE_SECONDS + 1n }), { inputMint: IN, outputMint: OUT, now: NOW });
    expect(long.warnings).toEqual([WARN_LONG_MANDATE]);
    expect(long.lines.at(-1)).toBe(`WARNING: ${WARN_LONG_MANDATE}`);
  });
});
