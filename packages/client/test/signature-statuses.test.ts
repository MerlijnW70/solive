import type { Signature } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { testSignature } from "../src/testing.js";
import { landingOf, type RpcLike, rpcTransport, SIGNATURE_STATUSES_LIMIT } from "../src/transport.js";

type Status = { err: unknown; confirmationStatus: string | null };

function statusRpc(answer: (signature: string) => Status | null, failFirst = 0) {
  const calls: { signatures: string[]; history: boolean }[] = [];
  let refusals = failFirst;
  const rpc = {
    getSignatureStatuses: (signatures: Signature[], config?: { searchTransactionHistory: boolean }) => ({
      send: async () => {
        if (refusals > 0) {
          refusals -= 1;
          throw new Error("HTTP error (429): Too Many Requests");
        }
        calls.push({ signatures: [...signatures], history: config?.searchTransactionHistory === true });
        return { context: { slot: 1n }, value: signatures.map(answer) };
      },
    }),
  } as unknown as RpcLike;
  return { rpc, calls };
}

const none = async () => undefined;

describe("signature statuses", () => {
  it("reads landed, failed or unknown for each signature, counting only confirmed or finalized answers", async () => {
    const answers: Record<string, Status | null> = {
      landed: { err: null, confirmationStatus: "confirmed" },
      final: { err: null, confirmationStatus: "finalized" },
      failed: { err: { InstructionError: [0, { Custom: 6008 }] }, confirmationStatus: "confirmed" },
      finalFailed: { err: "boom", confirmationStatus: "finalized" },
      processed: { err: null, confirmationStatus: "processed" },
      processedFailed: { err: "boom", confirmationStatus: "processed" },
      unsure: { err: null, confirmationStatus: null },
      missing: null,
    };
    const labels = new Map<string, string>(Object.keys(answers).map((label) => [testSignature(label), label]));
    const { rpc, calls } = statusRpc((signature) => answers[labels.get(signature) ?? ""] ?? null);
    const transport = rpcTransport(rpc, none);
    expect(await transport.signatureStatuses?.([...labels.keys()])).toEqual(["landed", "landed", "failed", "failed", null, null, null, null]);
    expect(calls).toEqual([{ signatures: [...labels.keys()], history: false }]);
    expect(landingOf(undefined)).toBeNull();
  });

  it("asks at most the limit per call and keeps the answers in order", async () => {
    expect(SIGNATURE_STATUSES_LIMIT).toBe(256);
    const signatures = Array.from({ length: SIGNATURE_STATUSES_LIMIT * 2 + 1 }, (_, i) => testSignature(i));
    const { rpc, calls } = statusRpc((signature) => (signatures.findIndex((one) => one === signature) % 2 === 0 ? { err: null, confirmationStatus: "confirmed" } : null));
    const found = await rpcTransport(rpc, none).signatureStatuses?.(signatures);
    expect(calls.map((call) => call.signatures.length)).toEqual([SIGNATURE_STATUSES_LIMIT, SIGNATURE_STATUSES_LIMIT, 1]);
    expect(calls.flatMap((call) => call.signatures)).toEqual(signatures);
    expect(found).toEqual(signatures.map((_, i) => (i % 2 === 0 ? "landed" : null)));
  });

  it("makes no call for no signatures and retries a rate-limited one", async () => {
    const quiet = statusRpc(() => null);
    expect(await rpcTransport(quiet.rpc, none).signatureStatuses?.([])).toEqual([]);
    expect(quiet.calls).toEqual([]);
    const limited = statusRpc(() => ({ err: null, confirmationStatus: "confirmed" }), 1);
    expect(await rpcTransport(limited.rpc, none).signatureStatuses?.([testSignature("one")])).toEqual(["landed"]);
    expect(limited.calls).toHaveLength(1);
  });
});
