import { type Address, isAddress } from "@solana/kit";
import { findIntentPda, getIntentDecoder, getIntentDiscriminatorBytes, InvalidInput } from "@intent-engine/core";
import { engineAccount, loadIntent } from "./accounts.js";
import type { IntentAccount } from "./client-types.js";
import type { Transport } from "./transport.js";

export type IntentRef = Address | { owner: Address; nonce: bigint };

export const INTENT_REF_RULE = "an intent is named by its address or by { owner, nonce }";

function checkedRef(ref: IntentRef, field: string): IntentRef {
  if (typeof ref === "string") {
    if (!isAddress(ref)) {
      throw new InvalidInput(field, "format", `${field} ${ref} is not a base58 address; ${INTENT_REF_RULE}`);
    }
    return ref;
  }
  if (ref === null || typeof ref !== "object" || !isAddress(ref.owner) || typeof ref.nonce !== "bigint" || ref.nonce < 0n) {
    throw new InvalidInput(field, "format", INTENT_REF_RULE);
  }
  return ref;
}

export async function intentAddress(ref: IntentRef, field = "intent"): Promise<Address> {
  const checked = checkedRef(ref, field);
  return typeof checked === "string" ? checked : (await findIntentPda(checked))[0];
}

export async function loadIntentRef(transport: Transport, ref: IntentRef, field = "intent"): Promise<IntentAccount> {
  const checked = checkedRef(ref, field);
  if (typeof checked !== "string") {
    return loadIntent(transport, checked.owner, checked.nonce);
  }
  const data = await engineAccount(transport, checked, getIntentDiscriminatorBytes(), "intent");
  return { address: checked, intent: getIntentDecoder().decode(data) };
}
