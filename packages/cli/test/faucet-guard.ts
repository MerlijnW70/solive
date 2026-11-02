export const FAUCET_ENV = "INTENT_ENGINE_FAUCET_URL";
export const FAUCET_HOST = "solive-faucet.vercel.app";

export const faucetHit = (host: string): string => `a test reached the real instant faucet at ${host}; give it a fake faucet fetch or set ${FAUCET_ENV}=off`;

const hits: string[] = [];

export function hostOf(input: unknown): string | undefined {
  try {
    const text = typeof input === "string" ? input : input instanceof URL ? input.href : (input as { url?: unknown }).url;
    return typeof text === "string" ? new URL(text).hostname : undefined;
  } catch {
    return undefined;
  }
}

export function guardedFetch(real: typeof fetch): typeof fetch {
  return (async (input, init) => {
    const host = hostOf(input);
    if (host === FAUCET_HOST) {
      hits.push(host);
      throw new Error(faucetHit(host));
    }
    return real(input, init);
  }) as typeof fetch;
}

export function assertNoFaucetHits(): void {
  const seen = hits.splice(0);
  if (seen.length > 0) {
    throw new Error(`${faucetHit(FAUCET_HOST)} (${seen.length} request${seen.length === 1 ? "" : "s"})`);
  }
}
