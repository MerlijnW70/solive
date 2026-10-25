import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Address, getBase16Encoder } from "@solana/kit";
import { IntentCoreError, type IntentParams } from "../src/index.js";
import { decodeParams } from "../src/internal.js";

export type Outcome = { ok?: string; err?: string; fee?: string; net?: string };
export type Vectors = {
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
    | "attest_spec_hash"
    | "attest_announcement"
    | "attest_seq"
    | "attest_delivered"
    | "attest_salt"
    | "attest_delivery_preimage"
    | "attest_delivery_message"
    | "attest_split_hash"
    | "attest_split_delivery_preimage"
    | "attest_split_message"
    | "attest_split_batch_with_ab_signatures"
    | "attest_filled"
    | "attest_revision"
    | "attest_max_fee_bps"
    | "flags"
    | "epoch"
    | "ext",
    string
  >;
  split_commits: { recipients: string[]; weights: string[]; hash: string }[];
  split_plans: { amount: string; weights: string[]; shares: string[] }[];
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

export const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./golden/vectors.json", import.meta.url)),
    "utf8",
  ),
) as Vectors;

export const bytes = (hex: string) => new Uint8Array(getBase16Encoder().encode(hex));
export const hexOf = (b: ArrayLike<number>) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const addr = (s: string) => s as Address;

export function settle<T>(f: () => T): { ok: T } | { err: string } {
  try {
    return { ok: f() };
  } catch (e) {
    if (e instanceof IntentCoreError) {
      return { err: e.engineError };
    }
    throw e;
  }
}

export function named(name: string): IntentParams {
  const entry = vectors.params.find((p) => p.name === name);
  if (!entry) {
    throw new Error(`no golden params named ${name}`);
  }
  return decodeParams(Number(entry.kind), bytes(entry.hex));
}
