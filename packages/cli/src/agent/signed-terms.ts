import { type Address, getBase58Encoder, type Instruction, type SignatureBytes, type TransactionSigner } from "@solana/kit";
import { findAssociatedTokenAddress, type Intent, type IntentParams, Kind } from "@intent-engine/core";
import { createExt, encodeParams, isMemoUrl, MEMO_URL_RULE, partnerOf, type SignedIntentFields, specMemo } from "@intent-engine/core/internal";
import { type Transport } from "@intent-engine/client";
import { loadConfig, memoInstruction, mintOf, plainHttpOnPublic } from "@intent-engine/client/internal";
import { tool } from "./names.js";
import { SPEC_URL_PLAIN } from "./create.js";
import { AgentRefusal } from "./problems.js";
import { type Order, orderSchema, partnerSchema } from "./shapes.js";
import { account, amount, InvalidInput, optional, text, time } from "./schema.js";

export const DEFAULT_SUBMIT_WITHIN = 60 * 60;
export const MAX_SUBMIT_WITHIN = 24 * 60 * 60;
const SIGNATURE_PATTERN = "^[1-9A-HJ-NP-Za-km-z]{64,88}$";

export const signedTerms = {
  owner: account("the wallet that signs the message and sells"),
  input_mint: account(),
  output_mint: account(),
  order: orderSchema,
  expires_at: time(),
  nonce: amount(),
  submit_by: time("unix seconds after which the signature can no longer be submitted"),
  epoch: amount("the owner's signing epoch the signature is bound to"),
  relayer_fee: amount("raw input units the owner pays, from the same allowance, to whoever submits the signature"),
  partner: optional(partnerSchema),
  spec_url: optional(
    text(`where the acceptance spec is published, ${MEMO_URL_RULE}; the relayer records it in a memo it signs with the create. It is not part of the owner's signature, so ${tool("find_jobs")} does not show it`),
  ),
};

export type SignedTerms = {
  owner: Address;
  input_mint: Address;
  output_mint: Address;
  order: Order;
  expires_at: bigint;
  nonce: bigint;
  submit_by: bigint;
  epoch: bigint;
  relayer_fee: bigint;
  partner?: { account: Address; bps: number };
  spec_url?: string;
};

export const SPEC_URL_UNSIGNED = `the spec url is not part of what the owner signs: the relayer records it in a memo it signs with the create, and ${tool("find_jobs")} and ${tool("get_spec")} read only a spec url the owner signs, so they do not show this one; give workers the url yourself`;

export const publishesLine = (url: string) => `Records: the acceptance spec's url ${url}, in a memo the relayer signs, which ${tool("find_jobs")} does not show`;

export async function publishedUrl(transport: Transport, params: IntentParams, url: string | undefined): Promise<string | undefined> {
  if (url === undefined) {
    return undefined;
  }
  if (params.kind !== Kind.AttestedResult || params.specHash.every((b) => b === 0)) {
    throw new InvalidInput([{ path: "spec_url", message: "needs an attested order with spec_hash" }]);
  }
  if (!isMemoUrl(url)) {
    throw new InvalidInput([{ path: "spec_url", message: `must be ${MEMO_URL_RULE}` }]);
  }
  if (await plainHttpOnPublic(transport, url)) {
    throw new InvalidInput([{ path: "spec_url", message: SPEC_URL_PLAIN }]);
  }
  return url;
}

export const published = (signer: TransactionSigner, url: string | undefined): Instruction[] =>
  url === undefined ? [] : [memoInstruction(signer, specMemo(url))];

export async function fieldsOf(transport: Transport, t: SignedTerms, params: IntentParams, outputTokenProgram: Address) {
  const { config } = await loadConfig(transport);
  const inputToken = await mintOf(transport, t.input_mint);
  const fields: SignedIntentFields = {
    domain: Uint8Array.from(config.domain),
    owner: t.owner,
    ownerInput: await findAssociatedTokenAddress({ owner: t.owner, mint: t.input_mint, tokenProgram: inputToken.tokenProgram }),
    inputMint: t.input_mint,
    outputMint: t.output_mint,
    receiver: await findAssociatedTokenAddress({ owner: t.owner, mint: t.output_mint, tokenProgram: outputTokenProgram }),
    nonce: t.nonce,
    expiresAt: t.expires_at,
    submitBy: t.submit_by,
    kind: params.kind,
    params: encodeParams(params),
    epoch: t.epoch,
    relayerFee: t.relayer_fee,
    ext: createExt(t.partner === undefined ? {} : { partner: { key: t.partner.account, bps: t.partner.bps } }),
  };
  return { config, inputToken, fields };
}

export function sameTerms(stored: Intent, fields: SignedIntentFields): boolean {
  const partner = partnerOf(fields.ext ?? new Uint8Array());
  return (
    stored.inputMint === fields.inputMint &&
    stored.outputMint === fields.outputMint &&
    stored.receiver === fields.receiver &&
    stored.expiresAt === fields.expiresAt &&
    stored.kind === fields.kind &&
    stored.flags === (fields.flags ?? 0) &&
    stored.partnerBps === (partner?.bps ?? 0) &&
    (partner === undefined || stored.partner === partner.key) &&
    stored.params.length === fields.params.length &&
    stored.params.every((byte, i) => byte === fields.params[i])
  );
}

export function signatureBytes(text: string): SignatureBytes {
  const bytes = new RegExp(SIGNATURE_PATTERN).test(text) ? getBase58Encoder().encode(text) : new Uint8Array();
  if (bytes.length !== 64) {
    throw new AgentRefusal("SignatureMalformed", "the signature must be 64 bytes written in base58");
  }
  return bytes as SignatureBytes;
}
