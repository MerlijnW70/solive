import * as core from "../src/index.js";
import {
  getEpochAdvancedEventEncoder,
  getPauseRaisedEventEncoder,
  getUserInitializedEventEncoder,
  IntentEngineEvent,
} from "../src/index.js";
import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { decodeEvent, EVENT_IX_TAG, NOTABLE } from "../src/events.js";

const KEY = "11111111111111111111111111111112" as Address;
const tagged = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
const names = Object.keys(IntentEngineEvent).filter((k) => Number.isNaN(Number(k)));
const screaming = (name: string) => name.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();

describe("event decoding", () => {
  it("recognises every engine event by its own discriminator", () => {
    expect(names).toHaveLength(36);
    const lookup = core as unknown as Record<string, unknown>;
    for (const name of names) {
      const discriminator = lookup[`${screaming(name)}_EVENT_DISCRIMINATOR`] as Uint8Array;
      const decoder = (lookup[`get${name}EventDecoder`] as () => { fixedSize?: number })();
      const body = new Uint8Array(decoder.fixedSize ?? 256);
      body.set(discriminator);
      const decoded = decodeEvent(tagged(body));
      expect(decoded?.name, name).toBe(name);
      expect(decoded?.notable, name).toBe(NOTABLE.has(name));
    }
  });

  it("marks only governance and authority events as notable and decodes their fields", () => {
    expect([...NOTABLE].sort()).toEqual([
      "AdminAccepted",
      "AdminProposed",
      "CapsRequiredSet",
      "CommitteeCreated",
      "ConfigInitialized",
      "ConfigUpdated",
      "EconomicsUpdated",
      "MandateClosed",
      "MandateCreated",
      "MintCapSet",
      "PauseLowered",
      "PauseRaised",
    ]);
    const pause = decodeEvent(tagged(getPauseRaisedEventEncoder().encode({ by: KEY, paused: 3 })));
    expect(pause).toEqual({ name: "PauseRaised", notable: true, fields: { by: KEY, paused: 3 } });
    const user = decodeEvent(tagged(getUserInitializedEventEncoder().encode({ owner: KEY })));
    expect(user).toEqual({ name: "UserInitialized", notable: false, fields: { owner: KEY } });
  });

  it("ignores data that is not an engine event", () => {
    const body = getPauseRaisedEventEncoder().encode({ by: KEY, paused: 1 });
    expect(EVENT_IX_TAG).toEqual(new Uint8Array([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]));
    expect(decodeEvent(new Uint8Array([...body]))).toBeNull();
    expect(decodeEvent(EVENT_IX_TAG.subarray(0, 7))).toBeNull();
    const wrongTag = tagged(body);
    wrongTag[7] = 0;
    expect(decodeEvent(wrongTag)).toBeNull();
    expect(decodeEvent(tagged(new Uint8Array(40)))).toBeNull();
  });

  it("reads an event that a later program version extended with appended fields", () => {
    const body = getEpochAdvancedEventEncoder().encode({ owner: KEY, epoch: 7n });
    const extended = tagged(new Uint8Array([...body, 1, 2, 3, 4, 5, 6, 7, 8]));
    expect(decodeEvent(extended)).toEqual({ name: "EpochAdvanced", notable: false, fields: { owner: KEY, epoch: 7n } });
  });
});
