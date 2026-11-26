import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Address } from "@solana/kit";
import { IntentStatus, Kind } from "@intent-engine/core";
import { decodeParams } from "@intent-engine/core/internal";
import type { Transport } from "@intent-engine/client";
import { chainTime, loadCommittee, loadIntent } from "@intent-engine/client/internal";
import { JudgeRefused } from "./judge-errors.js";
import { isResaved, RESAVED } from "./resaved.js";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

export async function escrowFor(transport: Transport, judge: Address, owner: Address, nonce: bigint) {
  const { address, intent } = await loadIntent(transport, owner, nonce);
  const params = decodeParams(intent.kind, Uint8Array.from(intent.params));
  if (params.kind !== Kind.AttestedResult || params.specHash.every((b) => b === 0)) {
    throw new JudgeRefused(`intent ${address} is not a proof escrow: an AttestedResult intent that commits a spec hash`);
  }
  if (intent.status !== IntentStatus.Open || intent.expiresAt <= (await chainTime(transport))) {
    throw new JudgeRefused(`intent ${address} is no longer open`);
  }
  const committee = params.attestor === judge ? null : await loadCommittee(transport, params.attestor);
  if (params.attestor !== judge && committee === null) {
    throw new JudgeRefused(`intent ${address} names ${params.attestor} as its judge, not ${judge}`);
  }
  if (committee !== null && !committee.members.includes(judge)) {
    throw new JudgeRefused(`intent ${address} names committee ${params.attestor} as its judge, and ${judge} is not one of its members`);
  }
  return {
    address,
    attestor: params.attestor,
    committee,
    specHash: hex(params.specHash),
    minResult: params.minResult,
    maxResult: params.maxResult,
  };
}

export async function pinnedSpec(spec: string, intent: Address, specHash: string): Promise<Buffer> {
  const bytes = await readFile(resolve(spec));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== specHash) {
    throw new JudgeRefused(`--spec ${spec} has sha256 ${sha256}, but intent ${intent} commits ${specHash}${isResaved(bytes, specHash) ? `; ${RESAVED}` : ""}`);
  }
  return bytes;
}
