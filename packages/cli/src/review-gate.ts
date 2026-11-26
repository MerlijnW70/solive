import type { Address } from "@solana/kit";
import type { DeliveryOpener } from "@intent-engine/core";
import { isSdkError, type SpecFetch, type Transport } from "@intent-engine/client";
import { readSpec } from "@intent-engine/client/internal";
import { INVITE_SOURCES, type SpecReach } from "./invites.js";
import { readReviewBlock } from "./review-block.js";
import type { Gate } from "./receipt-gate.js";

export async function gateAt(transport: Transport, get: SpecFetch, intent: Address, openers: readonly DeliveryOpener[], reach: SpecReach): Promise<Gate> {
  let fetching = false;
  const watched: SpecFetch = (url, init) => {
    fetching = true;
    return get(url, init);
  };
  try {
    const spec = await readSpec(transport, watched, intent, openers.length === 0 ? undefined : openers, reach.lookup, reach.rpcUrl, { sources: INVITE_SOURCES });
    if (spec === null || !spec.matches) {
      return undefined;
    }
    const read = readReviewBlock(spec.bytes);
    return "problem" in read ? { problem: read.problem } : read.pins === undefined ? undefined : { pins: read.pins };
  } catch (error) {
    if (isSdkError(error, "spec-sealed") || isSdkError(error, "spec-unreadable") || fetching) {
      return undefined;
    }
    throw error;
  }
}
