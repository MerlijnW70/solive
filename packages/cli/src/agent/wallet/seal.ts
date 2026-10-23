import { createHash } from "node:crypto";
import type { Address } from "@solana/kit";
import { isSealed, MAX_SEALED_RECIPIENTS, seal, SealedError, unseal } from "@intent-engine/core";
import { MAX_SPEC_BYTES } from "@intent-engine/client";
import { type AgentContext, define } from "../actions.js";
import { tool } from "../names.js";
import { InvalidInput, account, list, object, optional, text } from "../schema.js";
import { signerOf, walletKeypair } from "./guard.js";

export const SEAL_LIMIT = `seal to at most ${MAX_SEALED_RECIPIENTS} wallets in all, the attestor included`;

export const SEALED_UNCHECKED = "spec_url holds a sealed spec this wallet cannot open, so its sha256 was not checked against spec_hash";

export const SEALED_NEXT = `host sealed at an https url, byte for byte, then pass that url as spec_url and sha256 as spec_hash to ${tool("wallet_escrow")}`;

export const sealedTooLarge = (bytes: number): string => `sealed, it is ${bytes} bytes, over the ${MAX_SPEC_BYTES} bytes ${tool("get_spec")} reads; shorten the spec`;

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

export async function openedSpec(ctx: AgentContext, bytes: Uint8Array): Promise<Uint8Array | undefined> {
  if (!isSealed(bytes)) {
    return bytes;
  }
  const keypair = await walletKeypair(ctx);
  return keypair === undefined ? undefined : unseal(bytes, keypair).catch(() => undefined);
}

export const walletSealSpec = define({
  name: tool("wallet_seal_spec"),
  title: "Seal a spec for an invite-only job",
  description: `Seals an acceptance spec so only the wallets it invites and the attestor (the judge) can read it, in the form ${tool("get_spec")} opens. Sends nothing: host sealed at a public url, then pass that url as spec_url and sha256 as spec_hash to ${tool("wallet_escrow")}.`,
  effect: "read",
  input: object({
    text: text("the spec, exactly as invited workers should read it"),
    invite: list(account(), MAX_SEALED_RECIPIENTS, `the wallets that may read the spec, such as the workers you hire; ${SEAL_LIMIT}`, 1),
    attestor: optional(account("the escrow's attestor, who reads the spec to judge the work; default this wallet")),
  }),
  output: object({
    sealed: text("the sealed spec to host, byte for byte"),
    sha256: text("64 hex: the sha256 of the spec text; pass it as spec_hash"),
    sealed_sha256: text("64 hex: the sha256 of sealed, to check the hosted copy"),
    sealed_to: list(account(), MAX_SEALED_RECIPIENTS, "every wallet that can open it, the attestor included"),
    next: text(),
  }),
  run: async (ctx: AgentContext, input) => {
    const attestor: Address = input.attestor ?? (await signerOf(ctx)).address;
    const recipients = [...new Set([...input.invite, attestor])];
    if (recipients.length > MAX_SEALED_RECIPIENTS) {
      throw new InvalidInput([{ path: "invite", message: SEAL_LIMIT }]);
    }
    let sealed: Uint8Array;
    try {
      sealed = await seal(new TextEncoder().encode(input.text), recipients);
    } catch (error) {
      throw error instanceof SealedError ? new InvalidInput([{ path: "invite", message: error.message }]) : error;
    }
    if (sealed.length > MAX_SPEC_BYTES) {
      throw new InvalidInput([{ path: "text", message: sealedTooLarge(sealed.length) }]);
    }
    return {
      sealed: new TextDecoder().decode(sealed),
      sha256: sha256(input.text),
      sealed_sha256: sha256(sealed),
      sealed_to: recipients,
      next: SEALED_NEXT,
    };
  },
});
