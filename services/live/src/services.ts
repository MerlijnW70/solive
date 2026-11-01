import type { Address } from "@solana/kit";
import type { FeedConfig } from "./env.js";
import { DRIP_LAMPORTS } from "./limits.js";
import type { Reader } from "./reader.js";
import type { ServiceActivity, Services, ServiceState } from "./shapes.js";

export type Probe = (signal: AbortSignal) => Promise<number | null>;

export type WalletReading = { state: ServiceState; last_active: string | null };

export async function walletState(reader: Reader, wallet: Address | null, windowSecs: number, now: number): Promise<WalletReading> {
  if (wallet === null) {
    return { state: "unknown", last_active: null };
  }
  const last = await reader.lastActivity(wallet);
  if (last === null) {
    return { state: "unknown", last_active: null };
  }
  const at = Number(last) * 1000;
  return { state: at >= now - windowSecs * 1000 ? "up" : "quiet", last_active: new Date(at).toISOString() };
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

export async function servicesOf(
  reader: Reader,
  config: FeedConfig,
  probe: Probe,
  windowSecs: number,
  now: number,
  signal: AbortSignal,
): Promise<{ services: Services; active: ServiceActivity }> {
  const faucet = await faucetState(reader, config.faucet, probe, signal);
  const demo = await walletState(reader, config.demoWorker, windowSecs, now);
  const filler = await walletState(reader, config.filler, windowSecs, now);
  return {
    services: { faucet, demo_worker: demo.state, filler: filler.state },
    active: { demo_worker: demo.last_active, filler: filler.last_active },
  };
}
