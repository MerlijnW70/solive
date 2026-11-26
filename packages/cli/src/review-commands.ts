import { writeFile } from "node:fs/promises";
import { type Address, getBase16Decoder } from "@solana/kit";
import { Kind } from "@intent-engine/core";
import { decodeParams } from "@intent-engine/core/internal";
import type { Transport } from "@intent-engine/client";
import { loadIntent } from "@intent-engine/client/internal";
import { artifactSha256 } from "./artifact.js";
import type { Command } from "./command-types.js";
import { FlowRefused } from "./flows.js";
import type { Runtime } from "./runtime.js";
import { readReviewFile, reviewJson, type ReviewSignature, ReviewUnreadable, reviewSha256, signatureHolds, signedReview, type Statement, statementOf } from "./review.js";

type ReviewCommand = Extract<Command, { name: "review" }>;

export const REVIEW_NOT_SIGNED = "nothing was signed; add --yes to sign this statement with the reviewer key and write the review file";

export const REVIEW_NEXT = "hand this file to the judge, who passes it to judge with --review; another reviewer co-signs it with review --add";

export const notProofEscrow = (intent: Address): string => `intent ${intent} is not a proof escrow, so there is no work to review; nothing was signed`;

async function freshStatement(statement: Extract<ReviewCommand["statement"], { owner: Address }>, transport: Transport): Promise<Statement> {
  const { address, intent } = await loadIntent(transport, statement.owner, statement.nonce);
  const params = decodeParams(intent.kind, Uint8Array.from(intent.params));
  if (params.kind !== Kind.AttestedResult || params.specHash.every((b) => b === 0)) {
    throw new FlowRefused(notProofEscrow(address));
  }
  const deliveredSha256 = "sha256" in statement.work ? statement.work.sha256 : await artifactSha256(statement.work.artifact);
  return {
    cluster: await transport.genesisHash(),
    intent: address,
    nonce: statement.nonce,
    specSha256: getBase16Decoder().decode(params.specHash).toLowerCase(),
    deliveredSha256,
    verdict: statement.outcome,
    reason: statement.reason,
  };
}

async function heldStatement(path: string): Promise<{ statement: Statement; prior: ReviewSignature[] }> {
  const held = await readReviewFile(path).catch((error: unknown) => {
    throw error instanceof ReviewUnreadable ? new FlowRefused(`--add ${path} ${error.why}; nothing was signed`) : error;
  });
  const statement = statementOf(held);
  for (const signed of held.signatures) {
    if (!(await signatureHolds(statement, signed))) {
      throw new FlowRefused(`--add ${path} carries a signature of ${signed.reviewer} that does not sign its statement; nothing was signed`);
    }
  }
  return { statement, prior: held.signatures };
}

export async function reviewCommand(command: ReviewCommand, runtime: Runtime, transport: Transport): Promise<object> {
  const signer = await runtime.loadSigner(command.keypair);
  const { statement, prior } = "add" in command.statement ? await heldStatement(command.statement.add) : { statement: await freshStatement(command.statement, transport), prior: [] };
  const shown = {
    intent: statement.intent,
    nonce: statement.nonce,
    cluster: statement.cluster,
    spec_sha256: statement.specSha256,
    delivered_sha256: statement.deliveredSha256,
    verdict: statement.verdict,
    reason: statement.reason,
    statement_sha256: reviewSha256(statement),
    reviewer: signer.address,
  };
  if (!command.yes) {
    return { ...shown, signers: prior.map(({ reviewer }) => reviewer), signed: false, next: REVIEW_NOT_SIGNED };
  }
  const review = await signedReview(signer, statement, prior);
  await writeFile(command.out, reviewJson(review));
  return { ...shown, signers: review.signatures.map(({ reviewer }) => reviewer), signed: true, written: command.out, next: REVIEW_NEXT };
}
