import { createHash } from "node:crypto";
import { getAddressDecoder, getArrayDecoder, getStructDecoder, getU16Decoder } from "@solana/kit";
import type { EngineTransaction } from "@intent-engine/client";
import type { EngineEvent } from "@intent-engine/core";

export type Share = { payee: string; raw: bigint };

type Fields<Name extends EngineEvent["name"]> = Extract<EngineEvent, { name: Name }>["fields"];

const BPS = 10_000;
const MAX_SPLIT_RECIPIENTS = 8;
const SPLIT_INTENT_ACCOUNT = 2;
const TAG_BYTES = 8;
const FILL_BYTES = 18;

const tagOf = (instruction: string): Uint8Array => Uint8Array.from(createHash("sha256").update(`global:${instruction}`).digest().subarray(0, TAG_BYTES));

const SPLIT_CALLS = [
  { tag: tagOf("fill_attested_split"), claimAt: TAG_BYTES + FILL_BYTES },
  { tag: tagOf("fill_attested_split_committee"), claimAt: TAG_BYTES + FILL_BYTES + 1 },
];

const CLAIM = getStructDecoder([
  ["recipients", getArrayDecoder(getAddressDecoder())],
  ["weights", getArrayDecoder(getU16Decoder())],
]);

type Claim = { recipients: readonly string[]; weights: readonly number[] };

const tagged = (data: Uint8Array, tag: Uint8Array): boolean => data.length >= tag.length && tag.every((byte, i) => data[i] === byte);

function ownerOf(tx: EngineTransaction, account: string): string | null {
  return tx.tokens?.find((holding) => holding.account === account)?.owner ?? null;
}

function claimOf(tx: EngineTransaction, intent: string): Claim | null {
  const calls = [
    ...(tx.called ?? []).map((data, i) => ({ data, accounts: tx.calledAccounts?.[i] })),
    ...tx.emitted.map((data, i) => ({ data, accounts: tx.emittedAccounts?.[i] })),
  ];
  for (const { data, accounts } of calls) {
    if (accounts?.[SPLIT_INTENT_ACCOUNT] !== intent) {
      continue;
    }
    for (const { tag, claimAt } of SPLIT_CALLS) {
      if (!tagged(data, tag)) {
        continue;
      }
      try {
        return CLAIM.decode(data, claimAt);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function splitAmounts(net: bigint, weights: readonly number[]): bigint[] | null {
  if (weights.length === 0 || weights.length > MAX_SPLIT_RECIPIENTS || weights.reduce((sum, weight) => sum + weight, 0) !== BPS) {
    return null;
  }
  const amounts = weights.map((weight) => (net * BigInt(weight)) / BigInt(BPS));
  const heaviest = weights.reduce((top, weight, i) => (weight > (weights[top] ?? 0) ? i : top), 0);
  amounts[heaviest] = (amounts[heaviest] ?? 0n) + net - amounts.reduce((sum, amount) => sum + amount, 0n);
  return amounts;
}

export function attestedShares(tx: EngineTransaction, attested: Fields<"IntentAttested">): Share[] | null {
  const owner = ownerOf(tx, attested.payee);
  return owner === null ? null : [{ payee: owner, raw: attested.net }];
}

export function splitShares(tx: EngineTransaction, split: Fields<"IntentSplit">, held: readonly Fields<"ShareHeld">[]): Share[] | null {
  const claim = claimOf(tx, split.intent);
  if (claim === null || claim.recipients.length !== split.recipients || claim.weights.length !== claim.recipients.length) {
    return null;
  }
  const amounts = splitAmounts(split.net, claim.weights);
  if (amounts === null) {
    return null;
  }
  const owners = new Set((tx.tokens ?? []).flatMap(({ owner }) => (owner === undefined ? [] : [owner as string])));
  const credited = new Map<string, bigint>();
  for (const [index, wallet] of claim.recipients.entries()) {
    const raw = amounts[index] ?? 0n;
    if (raw === 0n) {
      continue;
    }
    const kept = held.find((share) => share.index === index);
    if (kept === undefined ? !owners.has(wallet) : kept.wallet !== wallet || kept.share !== raw) {
      return null;
    }
    credited.set(wallet, (credited.get(wallet) ?? 0n) + raw);
  }
  return credited.size === 0 ? null : [...credited.entries()].map(([payee, raw]) => ({ payee, raw }));
}
