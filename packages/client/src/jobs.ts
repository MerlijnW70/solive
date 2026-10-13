import { createHash } from "node:crypto";
import { AccountRole, type AccountSignerMeta, type Address, type Instruction, type Signature, type TransactionSigner } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  type AttestedResultParams,
  decodeEvent,
  decodeParams,
  deliveryMemo,
  getIntentDecoder,
  getIntentDiscriminatorBytes,
  getIntentSize,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  type Intent,
  IntentStatus,
  Kind,
  parseDeliveryMemo,
  parseSpecMemo,
  remainingOf,
} from "@intent-engine/core";
import { chainTime, createdAccount } from "./accounts.js";
import { MEMO_PROGRAM_ADDRESS, TRANSACTION_FETCHES, type Transport } from "./transport.js";

export const JOBS_LIMIT = 50;
export const SPEC_SCAN = 10;
export const DELIVERY_SCAN = 100;
export const MEMOS_PER_TRANSACTION = 8;
export const MAX_SPEC_BYTES = 1_048_576;
export const SPEC_TIMEOUT_MS = 10_000;

export type Job = {
  intent: Address;
  owner: Address;
  nonce: bigint;
  attestor: Address;
  specHash: string;
  specUrl: string | null;
  sells: bigint;
  judgeFee: bigint;
  inputMint: Address;
  expiresAt: bigint;
};

export type Spec = { url: string; text: string; sha256: string; matches: boolean };

export type DeliverInput = { worker: TransactionSigner; intent: Address; sha256: string; url: string };

export type Delivery = {
  intent: Address;
  worker: Address;
  sha256: string;
  url: string;
  signature: Signature;
  slot: bigint;
  blockTime: bigint | null;
};

export type SpecFetch = (url: string, init: { redirect: "error"; signal: AbortSignal }) => Promise<Response>;

export class NotDeliverable extends Error {
  readonly intent: Address;

  constructor(intent: Address, reason: string) {
    super(`intent ${intent} ${reason}`);
    this.name = "NotDeliverable";
    this.intent = intent;
  }
}

export class SpecUnreadable extends Error {
  readonly url: string;

  constructor(url: string, reason: string) {
    super(`the spec at ${url} ${reason}`);
    this.name = "SpecUnreadable";
    this.url = url;
  }
}

type Proof = { address: Address; intent: Intent; params: AttestedResultParams };

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

function proofOf(address: Address, intent: Intent): Proof | null {
  const params = decodeParams(intent.kind, Uint8Array.from(intent.params));
  return params.kind === Kind.AttestedResult && params.specHash.some((b) => b !== 0) ? { address, intent, params } : null;
}

async function proofAt(transport: Transport, address: Address): Promise<Proof | null> {
  const view = await createdAccount(transport, address);
  const tag = getIntentDiscriminatorBytes();
  if (view === null || view.owner !== INTENT_ENGINE_PROGRAM_ADDRESS || view.data.length !== getIntentSize() || !tag.every((b, i) => view.data[i] === b)) {
    return null;
  }
  return proofOf(address, getIntentDecoder().decode(view.data));
}

export async function openProofEscrows(transport: Transport, attestor?: Address): Promise<Proof[]> {
  const [accounts, now] = await Promise.all([transport.intents(), chainTime(transport)]);
  return accounts
    .map(({ address, data }) => proofOf(address, getIntentDecoder().decode(data)))
    .filter(
      (proof): proof is Proof =>
        proof !== null &&
        proof.intent.status === IntentStatus.Open &&
        proof.intent.expiresAt > now &&
        (attestor === undefined || proof.params.attestor === attestor),
    )
    .sort((a, b) => (a.intent.expiresAt === b.intent.expiresAt ? 0 : a.intent.expiresAt > b.intent.expiresAt ? -1 : 1))
    .slice(0, JOBS_LIMIT);
}

const createdIn = (emitted: readonly Uint8Array[], intent: Address): boolean =>
  emitted.some((data) => {
    const event = decodeEvent(data);
    return event?.name === "IntentCreated" && "intent" in event.fields && event.fields.intent === intent;
  });

export async function specUrlOf(transport: Transport, intent: Address): Promise<string | null> {
  for (const tx of await transport.engineTransactions(SPEC_SCAN, intent)) {
    if (tx.failed || !createdIn(tx.emitted, intent)) {
      continue;
    }
    const urls = new Set(
      (tx.memos ?? [])
        .slice(0, MEMOS_PER_TRANSACTION)
        .map(parseSpecMemo)
        .flatMap((memo) => (memo === null ? [] : [memo.url])),
    );
    return urls.size === 1 ? ([...urls][0] ?? null) : null;
  }
  return null;
}

export async function jobsOf(transport: Transport, attestor?: Address): Promise<Job[]> {
  const proofs = await openProofEscrows(transport, attestor);
  const urls: (string | null)[] = [];
  for (let at = 0; at < proofs.length; at += TRANSACTION_FETCHES) {
    urls.push(...(await Promise.all(proofs.slice(at, at + TRANSACTION_FETCHES).map(({ address }) => specUrlOf(transport, address)))));
  }
  return proofs.map(({ address, intent, params }, i) => ({
    intent: address,
    owner: intent.owner,
    nonce: intent.nonce,
    attestor: params.attestor,
    specHash: hex(params.specHash),
    specUrl: urls[i] ?? null,
    sells: remainingOf(intent),
    judgeFee: params.judgeFee,
    inputMint: intent.inputMint,
    expiresAt: intent.expiresAt,
  }));
}

async function bounded(response: Response, url: string): Promise<Uint8Array> {
  if (!response.ok) {
    throw new SpecUnreadable(url, `answered ${response.status}`);
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_SPEC_BYTES) {
    throw new SpecUnreadable(url, `is larger than ${MAX_SPEC_BYTES} bytes`);
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let next = await reader?.read(); next !== undefined && next.done !== true; next = await reader?.read()) {
    size += next.value.length;
    if (size > MAX_SPEC_BYTES) {
      await reader?.cancel();
      throw new SpecUnreadable(url, `is larger than ${MAX_SPEC_BYTES} bytes`);
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks);
}

export async function readSpec(transport: Transport, get: SpecFetch, intent: Address): Promise<Spec | null> {
  const proof = await proofAt(transport, intent);
  if (proof === null) {
    return null;
  }
  const url = await specUrlOf(transport, intent);
  if (url === null) {
    return null;
  }
  const bytes = await bounded(await get(url, { redirect: "error", signal: AbortSignal.timeout(SPEC_TIMEOUT_MS) }), url);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { url, text: new TextDecoder().decode(bytes), sha256, matches: sha256 === hex(proof.params.specHash) };
}

export function memoInstruction(signer: TransactionSigner, text: string): Instruction {
  const meta: AccountSignerMeta = { address: signer.address, role: AccountRole.READONLY_SIGNER, signer };
  return { programAddress: MEMO_PROGRAM_ADDRESS, accounts: [meta], data: new TextEncoder().encode(text) };
}

export async function deliveryInstructions(transport: Transport, input: DeliverInput): Promise<{ attestor: Address; instructions: Instruction[] }> {
  const { worker, intent } = input;
  const memo = deliveryMemo({ intent, sha256: input.sha256, url: input.url });
  const [proof, now] = await Promise.all([proofAt(transport, intent), chainTime(transport)]);
  if (proof === null) {
    throw new NotDeliverable(intent, "is not a proof escrow: an AttestedResult intent that commits a spec hash");
  }
  if (proof.intent.status !== IntentStatus.Open || proof.intent.expiresAt <= now) {
    throw new NotDeliverable(intent, "is no longer open");
  }
  const attestor = proof.params.attestor;
  return {
    attestor,
    instructions: [memoInstruction(worker, memo), getTransferSolInstruction({ source: worker, destination: attestor, amount: 0n })],
  };
}

export async function deliveriesOf(transport: Transport, judge: Address, intent?: Address): Promise<Delivery[]> {
  let judged: ReadonlySet<Address>;
  if (intent === undefined) {
    judged = new Set((await openProofEscrows(transport, judge)).map(({ address }) => address));
  } else {
    const proof = await proofAt(transport, intent);
    judged = new Set(proof !== null && proof.params.attestor === judge ? [intent] : []);
  }
  if (judged.size === 0) {
    return [];
  }
  return (await transport.engineTransactions(DELIVERY_SCAN, judge)).flatMap(({ signature, slot, blockTime, failed, memos, feePayer }) =>
    failed || feePayer === undefined
      ? []
      : (memos ?? [])
          .slice(0, MEMOS_PER_TRANSACTION)
          .map(parseDeliveryMemo)
          .flatMap((memo) =>
            memo === null || !judged.has(memo.intent)
              ? []
              : [{ ...memo, worker: feePayer, signature: signature as Signature, slot, blockTime }],
          ),
  );
}
