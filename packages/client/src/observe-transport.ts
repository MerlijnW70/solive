import {
  type Address,
  type Base64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type Signature,
  type Transaction,
} from "@solana/kit";
import { isSdkError } from "@intent-engine/core";
import { boundMembers } from "./memoized-transport.js";
import { type ConfirmOutcome, elapsedSince, type Observer, type SendEvent } from "./observe.js";
import { redactUrl } from "./redact-url.js";
import { unretried } from "./rpc-limits.js";
import { patiently } from "./rpc-retry.js";
import type { Transport } from "./rpc-shapes.js";

export type Asked = <T>(method: string, run: () => Promise<T>) => Promise<T>;

export const askedOf =
  (observer: Observer, wait?: (ms: number) => Promise<void>, retry = true): Asked =>
  (method, run) =>
    patiently(
      (attempt) => observer.request(method, attempt, retry ? run : () => unretried(method, run)),
      wait,
      undefined,
      (retried) => observer.retry({ method, ...retried }),
    );

export function transactionSend(tx: Transaction, lastValidBlockHeight: bigint | null): SendEvent {
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  return {
    signature: getSignatureFromTransaction(tx),
    payer: compiled.staticAccounts[0] as Address,
    instructions: "instructions" in compiled ? compiled.instructions.length : 0,
    lastValidBlockHeight,
  };
}

export const wireSend = (wire: Base64EncodedWireTransaction, lastValidBlockHeight: bigint | null): SendEvent =>
  transactionSend(getTransactionDecoder().decode(getBase64Encoder().encode(wire)), lastValidBlockHeight);

export function outcomeOf(error: unknown): ConfirmOutcome {
  if (isSdkError(error, "maybe-sent")) {
    return "unknown";
  }
  return isSdkError(error, "blockhash-expired") ? "expired" : "failed";
}

export type Delivered = { signature: string; slot?: bigint | undefined };

export async function delivering<T extends Delivered>(observer: Observer, sent: SendEvent, run: () => Promise<T>): Promise<T> {
  observer.send(sent);
  const started = performance.now();
  const { signature } = sent;
  try {
    const delivered = await run();
    observer.confirm({ signature, outcome: "confirmed", ...(delivered.slot === undefined ? {} : { slot: delivered.slot }), ms: elapsedSince(started) });
    return delivered;
  } catch (error) {
    observer.confirm({ signature, outcome: outcomeOf(error), ms: elapsedSince(started) });
    throw error;
  }
}

const OBSERVABLE = new WeakMap<object, (observer: Observer) => Transport>();

export function observable<T extends Transport>(transport: T, observedBy: (observer: Observer) => Transport): T {
  OBSERVABLE.set(transport, observedBy);
  return transport;
}

export function memberRequests(transport: Transport, observer: Observer): Transport {
  const members = boundMembers(transport);
  const wrapped = Object.entries(members).map(([name, member]: [string, unknown]) =>
    typeof member === "function" ? [name, (...args: unknown[]) => observer.request(name, 1, async () => (member as (...given: unknown[]) => unknown)(...args))] : [name, member],
  );
  return { ...members, ...Object.fromEntries(wrapped) } as Transport;
}

const signatureOfFailure = (error: unknown): Signature | undefined => {
  const signature = (error as { signature?: unknown } | null)?.signature;
  return typeof signature === "string" ? (signature as Signature) : undefined;
};

function deliveries(members: Transport, observer: Observer): Transport {
  return {
    ...members,
    send: async (instructions, payer) => {
      const started = performance.now();
      const report = (signature: Signature, outcome: ConfirmOutcome) => {
        observer.send({ signature, payer: payer.address, instructions: instructions.length, lastValidBlockHeight: null });
        observer.confirm({ signature, outcome, ms: elapsedSince(started) });
      };
      try {
        const signature = await members.send(instructions, payer);
        report(signature, "confirmed");
        return signature;
      } catch (error) {
        const signature = signatureOfFailure(error);
        if (signature !== undefined) {
          report(signature, outcomeOf(error));
        }
        throw error;
      }
    },
    sendWire: async (wire, latest) =>
      (await delivering(observer, wireSend(wire, latest.lastValidBlockHeight), async () => ({ signature: await members.sendWire(wire, latest) }))).signature,
    submitWire: async (wire) => {
      observer.send(wireSend(wire, null));
      return members.submitWire(wire);
    },
  };
}

export function observedTransport(transport: Transport, observer: Observer): Transport {
  if (observer.quiet) {
    return transport;
  }
  const registered = OBSERVABLE.get(transport);
  if (registered !== undefined) {
    return registered(observer);
  }
  return deliveries(memberRequests(transport, observer), observer);
}

export type Fetcher<I> = (url: string, init: I) => Promise<Response>;

export function observedFetch<I>(get: Fetcher<I>, observer: Observer): Fetcher<I> {
  if (observer.quiet) {
    return get;
  }
  return async (url, init) => {
    const started = performance.now();
    try {
      const response = await get(url, init);
      observer.fetch({ url: redactUrl(url), status: response.status, ms: elapsedSince(started) });
      return response;
    } catch (error) {
      observer.fetch({ url: redactUrl(url), status: null, ms: elapsedSince(started) });
      throw error;
    }
  };
}
