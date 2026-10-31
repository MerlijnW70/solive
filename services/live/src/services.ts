import type { Address } from "@solana/kit";
import type { FeedConfig } from "./env.js";
import { DRIP_LAMPORTS } from "./limits.js";
import type { Reader } from "./reader.js";
import type { Services, ServiceState } from "./shapes.js";

export type Probe = (signal: AbortSignal) => Promise<number | null>;

export async function walletState(reader: Reader, wallet: Address | null, windowSecs: number, now: number): Promise<ServiceState> {
  if (wallet === null) {
    return "unknown";
  }
  const last = await reader.lastActivity(wallet);
  return last !== null && Number(last) * 1000 >= now - windowSecs * 1000 ? "up" : "down";
}

export async function faucetState(reader: Reader, faucet: Address | null, probe: Probe, signal: AbortSignal): Promise<ServiceState> {
  if (faucet === null) {
    return "unknown";
  }
  let status: number | null;
  try {
    status = await probe(signal);
  } catch {
    status = null;
  }
  if (status !== 405) {
    return "down";
  }
  return (await reader.lamports(faucet)) >= DRIP_LAMPORTS ? "up" : "down";
}

export async function servicesOf(reader: Reader, config: FeedConfig, probe: Probe, windowSecs: number, now: number, signal: AbortSignal): Promise<Services> {
  return {
    faucet: await faucetState(reader, config.faucet, probe, signal),
    demo_worker: await walletState(reader, config.demoWorker, windowSecs, now),
    filler: await walletState(reader, config.filler, windowSecs, now),
  };
}
