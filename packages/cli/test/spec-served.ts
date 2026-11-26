import type { Address } from "@solana/kit";
import { specMemo } from "@intent-engine/core/internal";
import { h } from "./harness-state.js";
import { creation, ownerSigned } from "./harness-transport.js";

export const SERVED_SPEC_URL = "https://" + "example.org/jobs/served-spec.md";

export function servedSpec(intent: Address, text: string, url: string = SERVED_SPEC_URL): void {
  h.specPages.set(url, new TextEncoder().encode(text));
  h.engineLog.push({ ...creation(intent), ...ownerSigned(intent, [specMemo(url)]) });
}
