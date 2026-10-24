import { type Address, getAddressDecoder } from "@solana/kit";
import { splitN } from "../../src/bounty.js";
import { type BoardView, checkClaimTerms, claimSlot, claimUntil, stakeReceiverOnCancel, stakeReceiverOnRelease, stakeReceiverOnSettle } from "../../src/claims.js";
import { blobHead, closable, commitmentPreimage, decodeAnnState, encodeAnnState, fingerprintPreimage, mayAnnounce, refutes, splitHashPreimage } from "../../src/delivery.js";
import { IntentCoreError } from "../../src/errors.js";
import { releaseSettles, splitFee, splitFees } from "../../src/fee.js";
import { type IntentParams, Kind, requiredOut, validate } from "../../src/kinds.js";
import { inLane, mandateLane } from "../../src/mandate.js";
import { mulDivCeil, mulDivFloor } from "../../src/math.js";
import { attestedDeliveryPreimage, attestedSplitDeliveryPreimage } from "../../src/sig.js";
import { nextFreeNonce } from "../../src/state.js";

type Args = readonly string[];
type Run = (args: Args) => string;

const KEYS: readonly Address[] = [0, 1, 2, 3].map((k) => getAddressDecoder().decode(new Uint8Array(32).fill(k)));

function arg(args: Args, i: number): string {
  const value = args[i];
  if (value === undefined) {
    throw new TypeError(`argument ${i} is missing`);
  }
  return value;
}

const big = (args: Args, i: number): bigint => BigInt(arg(args, i));
const num = (args: Args, i: number): number => Number(arg(args, i));
const list = (args: Args, i: number): string[] => {
  const body = arg(args, i).slice(1);
  return body === "" ? [] : body.split(",");
};
const key = (index: string): Address => {
  const found = KEYS[Number(index)];
  if (found === undefined) {
    throw new TypeError(`key ${index} is not in the pool`);
  }
  return found;
};
const keyIndex = (address: Address | null): string => (address === null ? "none" : String(KEYS.indexOf(address)));
const orNone = (value: bigint | null): string => (value === null ? "none" : String(value));

const board = (args: Args): BoardView => ({ owner: key(arg(args, 0)), worker: key(arg(args, 1)), until: big(args, 2), held: 0n });
const filled = (args: Args, i: number, length: number): Uint8Array => new Uint8Array(length).fill(num(args, i));
const wallet = (byte: string): Address => getAddressDecoder().decode(new Uint8Array(32).fill(Number(byte)));
const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function blobHeadAnswer(args: Args): string {
  const head = blobHead(Uint8Array.from(list(args, 0).map(Number)));
  return `${head.count} ${head.mask} ${head.fps.map(hex).join("")} ${head.urlLen}`;
}

function splitHashAnswer(args: Args): string {
  const { bytes, len } = splitHashPreimage(list(args, 0).map(wallet), list(args, 1).map(Number));
  return `${hex(bytes)} ${len}`;
}

const attestedDelivery = (a: Args): string =>
  hex(
    attestedDeliveryPreimage({
      program: wallet(arg(a, 0)),
      domain: filled(a, 1, 32),
      intent: wallet(arg(a, 2)),
      payee: wallet(arg(a, 3)),
      amountIn: big(a, 4),
      result: big(a, 5),
      filled: big(a, 6),
      revision: num(a, 7),
      maxFeeBps: num(a, 8),
      extHash: filled(a, 9, 32),
      specHash: filled(a, 10, 32),
      announcement: wallet(arg(a, 11)),
      seq: big(a, 12),
      delivered: filled(a, 13, 32),
      salt: filled(a, 14, 16),
    }),
  );

const attestedSplitDelivery = (a: Args): string =>
  hex(
    attestedSplitDeliveryPreimage({
      program: wallet(arg(a, 0)),
      domain: filled(a, 1, 32),
      intent: wallet(arg(a, 2)),
      amountIn: big(a, 3),
      result: big(a, 4),
      filled: big(a, 5),
      revision: num(a, 6),
      maxFeeBps: num(a, 7),
      extHash: filled(a, 8, 32),
      specHash: filled(a, 9, 32),
      splitHash: filled(a, 10, 32),
      announcement: wallet(arg(a, 11)),
      seq: big(a, 12),
      delivered: filled(a, 13, 32),
      salt: filled(a, 14, 16),
    }),
  );

function intentOf(args: Args): IntentParams {
  const kind = num(args, 0);
  if (kind === 0) {
    return { kind: Kind.SwapExactIn, amountIn: big(args, 1), minOut: big(args, 2) };
  }
  if (kind === 1) {
    return { kind: Kind.LimitOrder, makeAmount: big(args, 1), takeAmount: big(args, 2) };
  }
  return { kind: Kind.DutchAuction, amountIn: big(args, 1), startOut: big(args, 2), endOut: big(args, 3), startTs: big(args, 4), endTs: big(args, 5) };
}

const PAIRS: Record<string, Run> = {
  mul_div_floor: (a) => String(mulDivFloor(big(a, 0), big(a, 1), big(a, 2))),
  mul_div_ceil: (a) => String(mulDivCeil(big(a, 0), big(a, 1), big(a, 2))),
  split_fee: (a) => {
    const s = splitFee(big(a, 0), num(a, 1));
    return `${s.fee} ${s.net}`;
  },
  split_fees: (a) => {
    const s = splitFees(big(a, 0), num(a, 1), num(a, 2), num(a, 3));
    return `${s.protocol} ${s.partner} ${s.net}`;
  },
  release_settles: (a) => String(releaseSettles({ amount: big(a, 0), judgeFee: big(a, 1), feeBps: num(a, 2), partnerBps: num(a, 3), cutBps: num(a, 4) })),
  split_n: (a) => splitN(big(a, 0), list(a, 1).map(Number)).join(","),
  claim_terms: (a) => {
    checkClaimTerms(num(a, 0), big(a, 1));
    return "done";
  },
  claim_until: (a) => {
    checkClaimTerms(num(a, 0), big(a, 1));
    return String(claimUntil(num(a, 0), big(a, 2), num(a, 3), big(a, 4)));
  },
  stake_on_release: (a) => keyIndex(stakeReceiverOnRelease(board(a), big(a, 3), list(a, 4).map(key))),
  stake_on_cancel: (a) => keyIndex(stakeReceiverOnCancel(board(a), big(a, 3))),
  stake_on_settle: (a) => keyIndex(stakeReceiverOnSettle(board(a), big(a, 3), arg(a, 4) === "1")),
  lane_of: (a) => orNone(mandateLane(big(a, 0))),
  in_lane: (a) => String(inLane(big(a, 0), big(a, 1))),
  next_free: (a) => orNone(nextFreeNonce({ nonceBase: big(a, 0), nonceBitmap: [1, 2, 3, 4].map((i) => big(a, i)) })),
  required_out: (a) => String(requiredOut(validate(intentOf(a)), big(a, 6), big(a, 7))),
  commitment_preimage: (a) => hex(commitmentPreimage(wallet(arg(a, 0)), wallet(arg(a, 1)), filled(a, 2, 16), filled(a, 3, 32))),
  fingerprint_preimage: (a) => hex(fingerprintPreimage(filled(a, 0, 32))),
  blob_head: blobHeadAnswer,
  may_announce: (a) => {
    mayAnnounce(claimSlot({ worker: key(arg(a, 1)), until: big(a, 2) }, big(a, 3)), key(arg(a, 4)));
    return "done";
  },
  ann_state: (a) => String(encodeAnnState(decodeAnnState(num(a, 0)))),
  closable: (a) => {
    closable(decodeAnnState(num(a, 0)), arg(a, 1) === "1", arg(a, 2) === "1", big(a, 3), big(a, 4), big(a, 5));
    return "done";
  },
  refutes: (a) => {
    refutes(big(a, 0), big(a, 1), key(arg(a, 2)), list(a, 3).map(key));
    return "done";
  },
  split_hash_preimage: splitHashAnswer,
  attested_delivery_preimage: attestedDelivery,
  attested_split_delivery_preimage: attestedSplitDelivery,
};

export function answer(line: string): string {
  const [name = "", ...args] = line.split(" ");
  const run = PAIRS[name];
  if (run === undefined) {
    return "throw UnknownPair";
  }
  try {
    return `ok ${run(args)}`;
  } catch (error) {
    if (error instanceof IntentCoreError) {
      return `err ${error.code}`;
    }
    return `throw ${error instanceof Error ? error.name : "Unknown"}`;
  }
}
