import {
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  isSolanaError,
  signTransactionMessageWithSigners,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  type Address,
  type KeyPairSigner,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
} from "@solana/kit";
import {
  CONFIRM_POLL_MS,
  CONFIRM_TIMEOUT_MS,
  DAILY_DRIPS,
  DAILY_PAGE,
  DEVNET_GENESIS_HASH,
  DRIP_WINDOW_SECS,
  MAX_HISTORY_PAGES,
  MAX_SIGNATURES_CHECKED,
  SEND_CHECK_MS,
  SIGNATURE_PAGE,
} from "./limits.js";
import { dripMessage, ownDrip } from "./tag.js";

export type FaucetRpc = Rpc<SolanaRpcApi>;

export type Clock = {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly signal: (ms: number) => AbortSignal;
};

export async function onDevnet(rpc: FaucetRpc): Promise<boolean> {
  const genesis = await rpc.getGenesisHash().send();
  return genesis === DEVNET_GENESIS_HASH;
}

export async function balanceOf(rpc: FaucetRpc, owner: Address): Promise<bigint> {
  const { value } = await rpc.getBalance(owner, { commitment: "confirmed" }).send();
  return BigInt(value);
}

async function paidBy(rpc: FaucetRpc, signature: Signature, faucet: Address): Promise<boolean> {
  const transaction = await rpc
    .getTransaction(signature, { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0 })
    .send();
  if (transaction === null) throw new Error("transaction listed but not found");
  return transaction.meta?.err === null && transaction.transaction.message.accountKeys[0] === faucet;
}

const listPage = (rpc: FaucetRpc, address: Address, before: Signature | undefined) =>
  rpc.getSignaturesForAddress(address, { commitment: "confirmed", limit: SIGNATURE_PAGE, ...(before === undefined ? {} : { before }) }).send();

const blockSecs = (blockTime: bigint | number | null, nowSecs: number): number => (blockTime === null ? nowSecs : Number(blockTime));

export type EarlierDrip = { readonly kind: "none" } | { readonly kind: "recent"; readonly retryAfter: number } | { readonly kind: "busy" };

export async function earlierDrip(rpc: FaucetRpc, recipient: Address, faucet: Address, nowSecs: number): Promise<EarlierDrip> {
  let before: Signature | undefined;
  let checked = 0;
  for (;;) {
    const page = await listPage(rpc, recipient, before);
    for (const entry of page) {
      const time = blockSecs(entry.blockTime, nowSecs);
      if (nowSecs - time >= DRIP_WINDOW_SECS) return { kind: "none" };
      if (entry.err !== null) continue;
      checked += 1;
      if (checked > MAX_SIGNATURES_CHECKED) return { kind: "busy" };
      if (await paidBy(rpc, entry.signature, faucet)) {
        return { kind: "recent", retryAfter: Math.max(1, Math.ceil(time + DRIP_WINDOW_SECS - nowSecs)) };
      }
    }
    const last = page[page.length - 1];
    if (page.length < SIGNATURE_PAGE || last === undefined) return { kind: "none" };
    before = last.signature;
  }
}

export type DailyCount = { readonly kind: "open" } | { readonly kind: "full"; readonly retryAfter: number };

export async function dailyCount(rpc: FaucetRpc, faucet: KeyPairSigner, nowSecs: number): Promise<DailyCount> {
  let before: Signature | undefined;
  let counted = 0;
  for (let pages = 0; pages < MAX_HISTORY_PAGES; pages += 1) {
    const page = await rpc
      .getSignaturesForAddress(faucet.address, { commitment: "confirmed", limit: DAILY_PAGE, ...(before === undefined ? {} : { before }) })
      .send();
    for (const entry of page) {
      const time = blockSecs(entry.blockTime, nowSecs);
      if (nowSecs - time >= DRIP_WINDOW_SECS) return { kind: "open" };
      if (entry.err !== null || !(await ownDrip(faucet, entry.signature, entry.memo))) continue;
      counted += 1;
      if (counted >= DAILY_DRIPS) return { kind: "full", retryAfter: Math.max(1, Math.ceil(time + DRIP_WINDOW_SECS - nowSecs)) };
    }
    const last = page[page.length - 1];
    if (page.length < DAILY_PAGE || last === undefined) return { kind: "open" };
    before = last.signature;
  }
  return { kind: "open" };
}

export type SendOutcome = "accepted" | "confirmed" | "failed" | "unknown";

export type Sent = { readonly signature: Signature; readonly sent: SendOutcome };

async function afterSendError(rpc: FaucetRpc, signature: Signature, clock: Clock, error: unknown): Promise<SendOutcome> {
  let status;
  try {
    status = (await rpc.getSignatureStatuses([signature]).send({ abortSignal: clock.signal(SEND_CHECK_MS) })).value[0];
  } catch {
    status = undefined;
  }
  if (status) {
    if (status.err !== null) return "failed";
    return status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized" ? "confirmed" : "accepted";
  }
  return isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE) ? "failed" : "unknown";
}

export async function sendDrip(rpc: FaucetRpc, signer: KeyPairSigner, recipient: Address, clock: Clock): Promise<Sent> {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const signed = await signTransactionMessageWithSigners(dripMessage(signer, recipient, blockhash));
  const signature = getSignatureFromTransaction(signed);
  try {
    await rpc
      .sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed" })
      .send({ abortSignal: clock.signal(CONFIRM_TIMEOUT_MS) });
    return { signature, sent: "accepted" };
  } catch (error) {
    return { signature, sent: await afterSendError(rpc, signature, clock, error) };
  }
}

export type Confirmation = "confirmed" | "failed" | "timeout";

export async function confirm(rpc: FaucetRpc, signature: Signature, clock: Clock, startedAt: number): Promise<Confirmation> {
  const deadline = startedAt + CONFIRM_TIMEOUT_MS;
  for (;;) {
    const left = deadline - clock.now();
    if (left <= 0) return "timeout";
    try {
      const { value } = await rpc.getSignatureStatuses([signature]).send({ abortSignal: clock.signal(left) });
      const status = value[0];
      if (status) {
        if (status.err !== null) return "failed";
        if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") return "confirmed";
      }
    } catch {
      if (clock.now() >= deadline) return "timeout";
    }
    const wait = Math.min(CONFIRM_POLL_MS, deadline - clock.now());
    if (wait <= 0) return "timeout";
    await clock.sleep(wait);
  }
}
