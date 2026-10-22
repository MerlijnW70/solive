import { type Address, getAddressDecoder } from "@solana/kit";
import { splitN } from "../../src/bounty.js";
import { type BoardView, checkClaimTerms, claimUntil, stakeReceiverOnCancel, stakeReceiverOnRelease, stakeReceiverOnSettle } from "../../src/claims.js";
import { IntentCoreError } from "../../src/errors.js";
import { releaseSettles, splitFee, splitFees } from "../../src/fee.js";
import { type IntentParams, Kind, requiredOut, validate } from "../../src/kinds.js";
import { inLane, mandateLane } from "../../src/mandate.js";
import { mulDivCeil, mulDivFloor } from "../../src/math.js";
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
