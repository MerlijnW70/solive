import { Kind } from "@intent-engine/core";
import { decodeParams } from "@intent-engine/core/internal";
import { type Transport } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { loadIntent } from "@intent-engine/client/internal";
import type { Command } from "./command-types.js";
import { JudgeRefused } from "./judge-errors.js";

export type JudgeDigestCommand = Extract<Command, { name: "judge-digest" }>;

export const DIGEST_NEXT =
  "the Ledger shows this digest when it signs the release; compare the two before pressing approve, and reject on any difference";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

export async function judgeDigest(command: JudgeDigestCommand, transport: Transport): Promise<object> {
  const { address, intent } = await loadIntent(transport, command.owner, command.nonce);
  const params = decodeParams(intent.kind, Uint8Array.from(intent.params));
  if (params.kind !== Kind.AttestedResult || params.specHash.every((b) => b === 0)) {
    throw new JudgeRefused(`intent ${address} is not a proof escrow: an AttestedResult intent that commits a spec hash`);
  }
  const result = command.result ?? params.minResult;
  if (result < params.minResult || result > params.maxResult) {
    throw new JudgeRefused(`--result ${result} lies outside the results intent ${address} accepts, ${params.minResult} to ${params.maxResult}`);
  }
  const opening = { sha256: command.sha256, salt: command.salt };
  const ballot = await createClient({ url: command.url, transport }).proofBallot({ intent: { owner: command.owner, nonce: command.nonce }, announcement: command.announcement, opening, result });
  return {
    intent: ballot.intent,
    judge: ballot.attestor,
    announcement: command.announcement,
    payee: ballot.payee,
    result,
    digest: hex(ballot.digest),
    next: DIGEST_NEXT,
  };
}
