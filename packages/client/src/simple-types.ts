import type { Address, Instruction, Signature, TransactionSigner } from "@solana/kit";
import type { Priority } from "./budget.js";
import type { Client, WatchCallback, WatchOptions } from "./client-types.js";
import type { Job } from "./jobs.js";
import type { Cluster } from "./simple-tokens.js";
import type { Transport } from "./transport.js";

export type ConnectOptions = ({ cluster: Cluster; url?: undefined } | { url: string; cluster?: undefined }) & {
  signer: TransactionSigner;
  transport?: Transport;
  priority?: Priority;
  allowMainnet?: boolean;
};

export type Sent = { signature: Signature; intent?: Address; nonce?: bigint; summary: string };

export type Preview = { summary: string; instructions: Instruction[]; intent?: Address; nonce?: bigint };

export type PreviewOption = { preview?: boolean };

export type Outcome<I> = I extends { preview: true } ? Preview : Sent;

export type Seconds = number | bigint;

export type SwapInput = PreviewOption & { sell: string; amount: string; buy: string; minReceive: string; expiresIn?: Seconds };

export type LimitInput = PreviewOption & { sell: string; amount: string; buy: string; price: string; expiresIn?: Seconds };

export type PayForWorkInput = PreviewOption & {
  amount: string;
  token?: string;
  judge: Address;
  specHash: string | Uint8Array;
  specUrl?: string;
  judgeFee?: string;
  expiresIn?: Seconds;
  recordToken?: string;
};

export type DeliverWorkInput = PreviewOption & { escrow: Address; sha256: string; url: string };

export type ReleaseInput = PreviewOption & { escrow: Address; to: Address; deliveredSha256: string; result?: number | bigint };

export type CancelInput = PreviewOption & ({ escrow: Address; intent?: undefined } | { intent: Address; escrow?: undefined });

export type HeldToken = { token: string; mint: Address; account: Address; amount: string };

export type WalletBalance = { sol: string; tokens: HeldToken[]; summary: string };

export type OpenWork = Job & { amount: string; fee: string; token: string };

export type SimpleClient = {
  readonly url: string;
  readonly signer: TransactionSigner;
  readonly client: Client;
  balance(tokens?: readonly string[]): Promise<WalletBalance>;
  swap<I extends SwapInput>(input: I): Promise<Outcome<I>>;
  limit<I extends LimitInput>(input: I): Promise<Outcome<I>>;
  payForWork<I extends PayForWorkInput>(input: I): Promise<Outcome<I>>;
  findWork(filter?: { judge?: Address }): Promise<OpenWork[]>;
  deliver<I extends DeliverWorkInput>(input: I): Promise<Outcome<I>>;
  release<I extends ReleaseInput>(input: I): Promise<Outcome<I>>;
  cancel<I extends CancelInput>(input: I): Promise<Outcome<I>>;
  watch(onChange: WatchCallback, signal: AbortSignal, filter?: WatchOptions): Promise<void>;
};
