import type { Address } from "@solana/kit";
import type { DeliveryOpener } from "@intent-engine/core";
import { isSdkError, type SpecFetch, type SpecSource, type Transport } from "@intent-engine/client";
import { readSpec } from "@intent-engine/client/internal";
import { inviteUnchecked, INVITES_UNREAD, type SpecReach } from "./invites.js";
import { readReviewBlock } from "./review-block.js";
import { type Gate, UNGATED } from "./receipt-gate.js";
import { sanitized } from "./untrusted-text.js";
import { lastingSpecRead } from "./fetch-class.js";

export const NO_SPEC_READ = "this escrow publishes no spec url, and no copy of its spec was found by its sha256";

export const specDiffers = (url: string, sha256: string): string => `the spec at ${sanitized(url)} now has sha256 ${sha256}, not the sha256 this escrow pins`;

const unknown = (why: string): Gate => ({ unknown: why });

const transient = (why: string): Gate => ({ unknown: why, transient: true });

export const gateUnread = (intent: Address): string => inviteUnchecked(intent, INVITES_UNREAD);

const messageOf = (error: unknown): string => sanitized(error instanceof Error ? error.message : String(error));

export async function gateAt(transport: Transport, get: SpecFetch, intent: Address, openers: readonly DeliveryOpener[], reach: SpecReach, sources: readonly SpecSource[]): Promise<Gate> {
  let fetching = false;
  const watched: SpecFetch = (url, init) => {
    fetching = true;
    return get(url, init);
  };
  try {
    const spec = await readSpec(transport, watched, intent, openers.length === 0 ? undefined : openers, reach.lookup, reach.rpcUrl, { sources });
    if (spec === null) {
      return unknown(NO_SPEC_READ);
    }
    if (!spec.matches) {
      return unknown(specDiffers(spec.url, spec.sha256));
    }
    const read = readReviewBlock(spec.bytes);
    return "problem" in read ? { problem: read.problem } : read.pins === undefined ? UNGATED : { pins: read.pins };
  } catch (error) {
    if (isSdkError(error, "spec-sealed")) {
      return unknown(messageOf(error));
    }
    if (isSdkError(error, "spec-unreadable")) {
      return lastingSpecRead(error, true) ? unknown(messageOf(error)) : transient(messageOf(error));
    }
    if (fetching) {
      return transient(messageOf(error));
    }
    throw error;
  }
}
