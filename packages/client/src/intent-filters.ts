import { type Address, getAddressEncoder, isAddress } from "@solana/kit";
import { decodeParams, type Intent, IntentStatus, InvalidInput, Kind } from "@intent-engine/core";
import type { AccountMatch, IntentQuery } from "./rpc-shapes.js";

export const INTENT_OWNER_AT = 8;
export const INTENT_INPUT_MINT_AT = 40;
export const INTENT_OUTPUT_MINT_AT = 72;
export const INTENT_KIND_AT = 168;
export const INTENT_STATUS_AT = 169;
export const INTENT_PARAMS_AT = 176;
export const ATTESTED_ATTESTOR_AT = INTENT_PARAMS_AT + 24;

const STATUSES: readonly number[] = Object.values(IntentStatus);
const KINDS: readonly number[] = [Kind.SwapExactIn, Kind.LimitOrder, Kind.DutchAuction, Kind.AttestedResult];

export const ATTESTOR_NEEDS_ATTESTED = "attestor filters AttestedResult intents only, so kind must be Kind.AttestedResult or left out";

function checkedAddress(field: string, value: Address | undefined): Address | undefined {
  if (value !== undefined && !isAddress(value)) {
    throw new InvalidInput(field, "format", `${field} ${String(value)} is not a base58 address`);
  }
  return value;
}

function checkedByte(field: string, value: number | undefined, allowed: readonly number[], names: string): number | undefined {
  if (value !== undefined && !allowed.includes(value)) {
    throw new InvalidInput(field, "range", `${field} ${String(value)} is not one of ${names}`);
  }
  return value;
}

export function checkedQuery(query: IntentQuery = {}): IntentQuery {
  const kind = checkedByte("kind", query.kind, KINDS, "the Kind values");
  const attestor = checkedAddress("attestor", query.attestor);
  if (attestor !== undefined && kind !== undefined && kind !== Kind.AttestedResult) {
    throw new InvalidInput("attestor", "conflict", ATTESTOR_NEEDS_ATTESTED);
  }
  return {
    owner: checkedAddress("owner", query.owner),
    status: checkedByte("status", query.status, STATUSES, "the IntentStatus values"),
    kind: attestor === undefined ? kind : Kind.AttestedResult,
    inputMint: checkedAddress("inputMint", query.inputMint),
    outputMint: checkedAddress("outputMint", query.outputMint),
    attestor,
  };
}

export function intentMatches(query: IntentQuery = {}): AccountMatch[] {
  const checked = checkedQuery(query);
  const at = (offset: number, address: Address | undefined): AccountMatch[] => (address === undefined ? [] : [{ offset, address }]);
  const byte = (offset: number, value: number | undefined): AccountMatch[] => (value === undefined ? [] : [{ offset, bytes: Uint8Array.of(value) }]);
  return [
    ...at(INTENT_OWNER_AT, checked.owner),
    ...at(INTENT_INPUT_MINT_AT, checked.inputMint),
    ...at(INTENT_OUTPUT_MINT_AT, checked.outputMint),
    ...byte(INTENT_KIND_AT, checked.kind),
    ...byte(INTENT_STATUS_AT, checked.status),
    ...at(ATTESTED_ATTESTOR_AT, checked.attestor),
  ];
}

export const matchBytes = (match: AccountMatch): Uint8Array =>
  "address" in match ? Uint8Array.from(getAddressEncoder().encode(match.address)) : Uint8Array.from(match.bytes);

function attestorOf(intent: Intent): Address | undefined {
  const params = decodeParams(intent.kind, Uint8Array.from(intent.params));
  return params.kind === Kind.AttestedResult ? params.attestor : undefined;
}

export function intentMatchesQuery(intent: Intent, query: IntentQuery = {}): boolean {
  const checked = checkedQuery(query);
  return (
    (checked.owner === undefined || intent.owner === checked.owner) &&
    (checked.status === undefined || intent.status === checked.status) &&
    (checked.kind === undefined || intent.kind === checked.kind) &&
    (checked.inputMint === undefined || intent.inputMint === checked.inputMint) &&
    (checked.outputMint === undefined || intent.outputMint === checked.outputMint) &&
    (checked.attestor === undefined || attestorOf(intent) === checked.attestor)
  );
}
