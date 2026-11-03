import type { Address, KeyPairSigner } from "@solana/kit";
import type { CallerLimit } from "./callers.js";
import { balanceOf, confirm, dailyCount, earlierDrip, onDevnet, sendDrip, type Clock, type FaucetRpc } from "./chain.js";
import { CONFIRM_TIMEOUT_MS, DRIP_LAMPORTS, DRIP_WINDOW_SECS, FLOOR_LAMPORTS, FUNDED_LAMPORTS, PENDING_RETRY_SECS } from "./limits.js";
import { agentOf, callerMark } from "./mark.js";
import { callerOf, parseBody, type Headers } from "./request.js";
import { faucetSigner } from "./secret.js";

export type DripRequest = {
  readonly method: string | undefined;
  readonly headers: Headers;
  readonly body: string | undefined;
  readonly remote?: string | undefined;
};

export type DripBody =
  | { readonly signature: string; readonly lamports: string }
  | { readonly error: string }
  | { readonly error: string; readonly retry_after: number };

export type DripResponse = { readonly status: number; readonly body: DripBody; readonly headers?: Readonly<Record<string, string>> };

export type DripDeps = {
  readonly rpc: () => FaucetRpc;
  readonly secret: () => string | undefined;
  readonly callers: CallerLimit;
  readonly clock: Clock;
  readonly log: (line: string) => void;
};

export const REASONS = {
  method: "Send a POST request to this address with a JSON body that holds your wallet address.",
  caller: "This network already received the most drips this faucet instance allows for one day, so wait retry_after seconds before you ask again.",
  checks: "This network asked this faucet instance too often in the last hour, so wait retry_after seconds before you ask again.",
  instance: "This faucet instance has sent its daily limit of drips, so wait retry_after seconds, or get devnet SOL at https://faucet.solana.com.",
  daily: "The faucet has reached its daily limit of drips, so wait retry_after seconds, or get devnet SOL at https://faucet.solana.com.",
  funded: "This address already holds 0.25 SOL or more, which is enough to start, so no drip was sent.",
  recent: "This address received a drip from this faucet in the last day, so wait retry_after seconds before you ask again.",
  pending: "A drip to this address is already on its way, so wait a minute before you ask again.",
  busy: "This address has too much recent activity to check for an earlier drip, so ask again tomorrow.",
  cluster: "The faucet node is not on devnet, so nothing was sent and the faucet owner needs to fix the node url.",
  config: "The faucet is not set up yet, so nothing was sent and the faucet owner needs to set its key.",
  floor: "The faucet holds too little SOL right now, so try again later.",
  node: "The devnet node did not answer, so nothing was sent and you can try again in a minute.",
} as const;

export const failedSend = (signature: string): string =>
  `The transfer ${signature} failed, so no SOL arrived and you can try again in a minute.`;
export const unknownSend = (signature: string): string =>
  `The faucet cannot tell whether the transfer ${signature} reached devnet, so check it in a devnet explorer before you ask again.`;
export const unconfirmed = (signature: string): string =>
  `The transfer ${signature} did not confirm within ${CONFIRM_TIMEOUT_MS / 1000} seconds, so check it in a devnet explorer before you ask again.`;

const error = (status: number, reason: string, headers?: Record<string, string>): DripResponse =>
  headers === undefined ? { status, body: { error: reason } } : { status, body: { error: reason }, headers };
const limited = (reason: string, retryAfter: number): DripResponse => ({
  status: 429,
  body: { error: reason, retry_after: retryAfter },
  headers: { "retry-after": String(retryAfter) },
});

type Outcome = { readonly response: DripResponse; readonly attempted: boolean };

type Ready = { readonly rpc: FaucetRpc; readonly signer: KeyPairSigner };

async function ready(deps: DripDeps, recipient: Address): Promise<Ready | DripResponse> {
  try {
    const rpc = deps.rpc();
    if (!(await onDevnet(rpc))) return error(503, REASONS.cluster);
    const signer = await faucetSigner(deps.secret());
    if (signer === undefined) return error(503, REASONS.config);
    if ((await balanceOf(rpc, recipient)) >= FUNDED_LAMPORTS) return limited(REASONS.funded, DRIP_WINDOW_SECS);
    const earlier = await earlierDrip(rpc, recipient, signer.address, Math.floor(deps.clock.now() / 1000));
    if (earlier.kind !== "none") {
      const retryAfter = earlier.kind === "recent" ? earlier.retryAfter : DRIP_WINDOW_SECS;
      deps.callers.remember(recipient, earlier.kind, deps.clock.now() + retryAfter * 1000, deps.clock.now());
      return limited(REASONS[earlier.kind], retryAfter);
    }
    const day = await dailyCount(rpc, signer, Math.floor(deps.clock.now() / 1000));
    if (day.kind === "full") return limited(REASONS.daily, day.retryAfter);
    if ((await balanceOf(rpc, signer.address)) < FLOOR_LAMPORTS) return error(503, REASONS.floor);
    return { rpc, signer };
  } catch {
    return error(503, REASONS.node);
  }
}

async function fund(deps: DripDeps, recipient: Address): Promise<Outcome> {
  const checked = await ready(deps, recipient);
  if ("status" in checked) return { response: checked, attempted: false };
  const slot = deps.callers.reserveSend(deps.clock.now());
  if (!slot.ok) return { response: limited(REASONS.instance, slot.retryAfter), attempted: false };
  const outcome = await send(deps, checked, recipient);
  if (!outcome.attempted) slot.release();
  return outcome;
}

async function send(deps: DripDeps, { rpc, signer }: Ready, recipient: Address): Promise<Outcome> {
  const startedAt = deps.clock.now();
  let sent;
  try {
    sent = await sendDrip(rpc, signer, recipient, deps.clock);
  } catch {
    return { response: error(503, REASONS.node), attempted: false };
  }
  if (sent.sent === "failed") return { response: error(503, failedSend(sent.signature)), attempted: false };
  if (sent.sent === "unknown") return { response: error(503, unknownSend(sent.signature)), attempted: true };
  const result = sent.sent === "confirmed" ? "confirmed" : await confirm(rpc, sent.signature, deps.clock, startedAt);
  if (result === "failed") return { response: error(503, failedSend(sent.signature)), attempted: false };
  if (result === "timeout") return { response: error(503, unconfirmed(sent.signature)), attempted: true };
  return { response: { status: 200, body: { signature: sent.signature, lamports: DRIP_LAMPORTS.toString() } }, attempted: true };
}

export function record(deps: DripDeps, headers: Headers, remote: string | undefined, status: number, signature?: string): void {
  const caller = callerMark(deps.secret(), deps.clock.now(), callerOf(headers, remote));
  const agent = agentOf(headers);
  deps.log(
    JSON.stringify({
      status,
      ...(signature === undefined ? {} : { signature }),
      ...(caller === undefined ? {} : { caller }),
      ...(agent === undefined ? {} : { agent }),
    }),
  );
}

export async function drip(request: DripRequest, deps: DripDeps): Promise<DripResponse> {
  const response = await answer(request, deps);
  const signature = "signature" in response.body ? response.body.signature : undefined;
  record(deps, request.headers, request.remote, response.status, signature);
  return response;
}

async function answer(request: DripRequest, deps: DripDeps): Promise<DripResponse> {
  if (request.method !== "POST") return error(405, REASONS.method, { allow: "POST" });
  const parsed = parseBody(request.body);
  if (!parsed.ok) return error(400, parsed.error);
  const now = deps.clock.now();
  deps.callers.forget(now);
  const known = deps.callers.recall(parsed.address, now);
  if (known !== undefined) return limited(REASONS[known.reason], known.retryAfter);
  const caller = callerOf(request.headers, request.remote);
  const reservation = deps.callers.reserve(caller, now);
  if (!reservation.ok) return limited(REASONS.caller, reservation.retryAfter);
  const free = deps.callers.hold(parsed.address);
  if (free === undefined) {
    reservation.release();
    return limited(REASONS.pending, PENDING_RETRY_SECS);
  }
  try {
    const spent = deps.callers.spend(caller, now);
    if (!spent.ok) {
      reservation.release();
      return limited(REASONS.checks, spent.retryAfter);
    }
    const outcome = await fund(deps, parsed.address);
    if (!outcome.attempted) reservation.release();
    if (outcome.response.status === 200) deps.callers.remember(parsed.address, "recent", deps.clock.now() + DRIP_WINDOW_SECS * 1000, deps.clock.now());
    return outcome.response;
  } finally {
    free();
  }
}
