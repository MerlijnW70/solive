import { IntentCoreError } from "./errors.js";
import { BPS_DENOMINATOR } from "./fee.js";
import { mulDivFloor, U64_MAX } from "./math.js";

export const MAX_RECIPIENTS = 16;

export function splitN(amount: bigint, weightsBps: readonly number[]): bigint[] {
  const len = weightsBps.length;
  if (len === 0 || len > MAX_RECIPIENTS) {
    throw new IntentCoreError("InvalidParams");
  }
  let sum = 0n;
  for (const w of weightsBps) {
    if (!Number.isInteger(w) || w < 0) {
      throw new IntentCoreError("InvalidParams");
    }
    sum += BigInt(w);
  }
  if (sum !== BPS_DENOMINATOR) {
    throw new IntentCoreError("InvalidParams");
  }
  if (amount < 0n || amount > U64_MAX) {
    throw new IntentCoreError("Overflow");
  }
  const amounts: bigint[] = [];
  let distributed = 0n;
  let heaviest = 0;
  let heaviestWeight = 0;
  weightsBps.forEach((w, i) => {
    const share = mulDivFloor(amount, BigInt(w), BPS_DENOMINATOR);
    amounts.push(share);
    distributed += share;
    if (w > heaviestWeight) {
      heaviestWeight = w;
      heaviest = i;
    }
  });
  const dust = amount - distributed;
  const top = amounts[heaviest];
  if (top === undefined) {
    throw new IntentCoreError("InvalidParams");
  }
  amounts[heaviest] = top + dust;
  return amounts;
}
