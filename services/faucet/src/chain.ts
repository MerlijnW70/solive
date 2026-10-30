import {
  AccountRole,
  appendTransactionMessageInstruction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
} from "@solana/kit";
import {
  CONFIRM_POLL_MS,
  CONFIRM_TIMEOUT_MS,
  DEVNET_GENESIS_HASH,
  DRIP_LAMPORTS,
  DRIP_WINDOW_SECS,
  MAX_SIGNATURES_CHECKED,
  SIGNATURE_PAGE,
} from "./limits.js";

export type FaucetRpc = Rpc<SolanaRpcApi>;

export type Clock = {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly signal: (ms: number) => AbortSignal;
};

export const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;
const TRANSFER = 2;

export async function onDevnet(rpc: FaucetRpc): Promise<boolean> {
  const genesis = await rpc.getGenesisHash().send();
  return genesis === DEVNET_GENESIS_HASH;
}

export async function balanceOf(rpc: FaucetRpc, owner: Address): Promise<bigint> {
  const { value } = await rpc.getBalance(owner, { commitment: "confirmed" }).send();
  return BigInt(value);
}

export type EarlierDrip = { readonly kind: "none" } | { readonly kind: "recent"; readonly retryAfter: number } | { readonly kind: "busy" };

export async function earlierDrip(rpc: FaucetRpc, recipient: Address, faucet: Address, nowSecs: number): Promise<EarlierDrip> {
  let before: Signature | undefined;
  let checked = 0;
  for (;;) {
    const page = await rpc
      .getSignaturesForAddress(recipient, { commitment: "confirmed", limit: SIGNATURE_PAGE, ...(before === undefined ? {} : { before }) })
      .send();
    for (const entry of page) {
      const time = entry.blockTime === null ? nowSecs : Number(entry.blockTime);
      if (nowSecs - time >= DRIP_WINDOW_SECS) return { kind: "none" };
      if (entry.err !== null) continue;
      checked += 1;
      if (checked > MAX_SIGNATURES_CHECKED) return { kind: "busy" };
      const transaction = await rpc
        .getTransaction(entry.signature, { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0 })
        .send();
      if (transaction === null) throw new Error("transaction listed but not found");
      if (transaction.meta?.err === null && transaction.transaction.message.accountKeys[0] === faucet) {
        return { kind: "recent", retryAfter: Math.max(1, Math.ceil(time + DRIP_WINDOW_SECS - nowSecs)) };
      }
    }
    const last = page[page.length - 1];
    if (page.length < SIGNATURE_PAGE || last === undefined) return { kind: "none" };
    before = last.signature;
  }
}

export function transferInstruction(from: KeyPairSigner, to: Address, amount: bigint): Instruction {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, TRANSFER, true);
  view.setBigUint64(4, amount, true);
  return {
    programAddress: SYSTEM_PROGRAM,
    accounts: [
      { address: from.address, role: AccountRole.WRITABLE_SIGNER, signer: from },
      { address: to, role: AccountRole.WRITABLE },
    ],
    data,
  } as Instruction;
}

export type Sent = { readonly signature: Signature; readonly sent: boolean };

export async function sendDrip(rpc: FaucetRpc, signer: KeyPairSigner, recipient: Address, clock: Clock): Promise<Sent> {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstruction(transferInstruction(signer, recipient, DRIP_LAMPORTS), m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signed);
  try {
    await rpc
      .sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed" })
      .send({ abortSignal: clock.signal(CONFIRM_TIMEOUT_MS) });
    return { signature, sent: true };
  } catch {
    return { signature, sent: false };
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
