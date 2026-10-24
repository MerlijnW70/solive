import type { Address } from "@solana/kit";
import {
  decodeParams,
  type FeeConfig,
  formatAmount,
  type Intent,
  Kind,
  kindBit,
  PAUSE_FILL,
  splitFees,
} from "@intent-engine/core";
import { mintOf } from "./accounts.js";
import { readableIntent } from "./job-proofs.js";
import type { Job } from "./job-specs.js";
import type { Transport } from "./transport.js";

export type PayTerms = FeeConfig & { paused: number; fillDisabledKinds: bigint };

export type JobPay = { netPay: string; payable: boolean };

export function releaseNet(intent: Intent, terms: PayTerms): bigint | null {
  if ((terms.paused & PAUSE_FILL) !== 0 || (terms.fillDisabledKinds & kindBit(Kind.AttestedResult)) !== 0n || intent.agentFee !== 0n) {
    return null;
  }
  if (intent.filled > intent.escrowed) {
    return null;
  }
  const amountIn = intent.escrowed - intent.filled;
  const params = decodeParams(intent.kind, Uint8Array.from(intent.params));
  if (params.kind !== Kind.AttestedResult || params.amountIn !== amountIn || params.judgeFee > amountIn) {
    return null;
  }
  try {
    return splitFees(amountIn - params.judgeFee, intent.feeBps, intent.partnerBps, intent.partnerCutBps).net;
  } catch {
    return null;
  }
}

async function scaleOf(decimalsOf: (mint: Address) => Promise<number>, mint: Address): Promise<number | undefined> {
  try {
    return await decimalsOf(mint);
  } catch {
    return undefined;
  }
}

export async function jobPays(
  transport: Transport,
  jobs: readonly Job[],
  terms: PayTerms,
  decimalsOf: (mint: Address) => Promise<number> = async (mint) => (await mintOf(transport, mint)).decimals,
): Promise<JobPay[]> {
  const mints = [...new Set(jobs.map(({ inputMint }) => inputMint))];
  const [held, decimals] = await Promise.all([
    transport.intents(),
    Promise.all(mints.map(async (mint) => [mint, await scaleOf(decimalsOf, mint)] as const)),
  ]);
  const intents = new Map(held.map(({ address, data }) => [address, data]));
  const scales = new Map(decimals);
  return jobs.map(({ intent, inputMint }) => {
    const data = intents.get(intent);
    const scale = scales.get(inputMint);
    const found = data === undefined ? null : readableIntent(data);
    const net = found === null || scale === undefined ? null : releaseNet(found, terms);
    return net === null ? { netPay: "0", payable: false } : { netPay: formatAmount(net, scale), payable: true };
  });
}
