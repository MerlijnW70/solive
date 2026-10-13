import type { Address } from "@solana/kit";
import { describe, expect, expectTypeOf, it } from "vitest";
import { type EngineEvent, eventNamed } from "../src/events.js";

const KEY = "11111111111111111111111111111112" as Address;

describe("eventNamed", () => {
  const events = [
    { name: "PauseRaised", notable: true, fields: { by: KEY, paused: 1 } },
    { name: "UserInitialized", notable: false, fields: { owner: KEY } },
    { name: "PauseRaised", notable: true, fields: { by: KEY, paused: 3 } },
  ] as unknown as (EngineEvent & { slot: bigint })[];

  it("returns the first event with the name, typed as that event, with the caller's extra fields", () => {
    const raised = eventNamed(events, "PauseRaised");
    expect(raised).toBe(events[0]);
    expectTypeOf(raised).toEqualTypeOf<(Extract<EngineEvent, { name: "PauseRaised" }> & { slot: bigint }) | undefined>();
    expectTypeOf<NonNullable<typeof raised>["name"]>().toEqualTypeOf<"PauseRaised">();
  });

  it("returns undefined when no event has the name", () => {
    expect(eventNamed(events, "IntentFilled")).toBeUndefined();
  });
});
