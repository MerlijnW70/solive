import { AccountRole, type AccountSignerMeta, type Address, type Instruction, type TransactionSigner } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { decodeEvent, type EngineEvent, parseReleaseMemo, releaseMemo } from "@intent-engine/core";
import { type EngineTransaction, MEMO_PROGRAM_ADDRESS } from "./transport.js";

export const RELEASE_MARK = " release:";

const BASE58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;

export type FollowUp = { sha256: string; release: string };

export function followUpMemo(sha256: string, release: string): string {
  if (!BASE58_SIGNATURE.test(release)) {
    throw new RangeError("a follow-up names its release by a base58 signature");
  }
  return `${releaseMemo(sha256)}${RELEASE_MARK}${release}`;
}

export function parseFollowUpMemo(text: string): FollowUp | null {
  const at = text.indexOf(RELEASE_MARK);
  if (at < 0) {
    return null;
  }
  const sha256 = parseReleaseMemo(text.slice(0, at));
  const release = text.slice(at + RELEASE_MARK.length);
  return sha256 === null || !BASE58_SIGNATURE.test(release) ? null : { sha256, release };
}

export function memosSignedBy(transaction: EngineTransaction, signer: Address): string[] {
  return (transaction.memos ?? []).filter((_, i) => transaction.memoSigners?.[i]?.includes(signer) === true);
}

export function releaseSigners(release: EngineTransaction, attestor: Address): Address[] {
  for (const data of release.emitted) {
    const event = decodeEvent(data) as EngineEvent | null;
    if (event?.name === "CommitteeAttested" && event.fields.committee === attestor) {
      return [...event.fields.signers];
    }
  }
  return [attestor];
}

export function followUpOf(
  transactions: readonly EngineTransaction[],
  release: string,
  attestor: Address,
  signers: readonly Address[] = [attestor],
): (FollowUp & { signature: string }) | null {
  for (const transaction of transactions) {
    if (transaction.failed || transaction.feePayer === undefined || !signers.includes(transaction.feePayer)) {
      continue;
    }
    const found = (transaction.memos ?? []).map(parseFollowUpMemo).find((memo) => memo !== null && memo.release === release);
    if (found !== undefined && found !== null) {
      return { ...found, signature: transaction.signature };
    }
  }
  return null;
}

export function recordedDelivery(transactions: readonly EngineTransaction[], release: EngineTransaction, attestor: Address): string | null {
  const signers = releaseSigners(release, attestor);
  const inline = signers
    .flatMap((signer) => memosSignedBy(release, signer))
    .map(parseReleaseMemo)
    .find((hash) => hash !== null);
  if (inline !== undefined) {
    return inline;
  }
  return followUpOf(transactions, release.signature, attestor, signers)?.sha256 ?? null;
}

export function followUpInstructions(judge: TransactionSigner, intent: Address, sha256: string, release: string): Instruction[] {
  return [memoInstruction(judge, followUpMemo(sha256, release)), getTransferSolInstruction({ source: judge, destination: intent, amount: 0n })];
}

export function memoInstruction(signer: TransactionSigner, text: string): Instruction {
  const meta: AccountSignerMeta = { address: signer.address, role: AccountRole.READONLY_SIGNER, signer };
  return { programAddress: MEMO_PROGRAM_ADDRESS, accounts: [meta], data: new TextEncoder().encode(text) };
}
