import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as core from "../src/internal.js";
import { decodeEvent, ENGINE_EVENT_NAMES, EVENT_IX_TAG } from "../src/events.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const root = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const idlEvents = (JSON.parse(root("idl/intent_engine.json")) as { events: { name: string; discriminator: number[] }[] }).events;
const programEvents = [...root("programs/intent_engine/src/events.rs").matchAll(/#\[event\]\s*pub struct (\w+)/g)].map((m) => m[1]);
const screaming = (name: string) => name.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();

describe("every event the program emits is named in TypeScript", () => {
  it("lists the same events in the program source and its IDL", () => {
    expect(idlEvents.length).toBeGreaterThan(0);
    expect([...programEvents].sort()).toEqual(idlEvents.map((event) => event.name).sort());
  });

  it("names each IDL event in the decoder and nothing else", () => {
    expect([...ENGINE_EVENT_NAMES].sort()).toEqual(idlEvents.map((event) => event.name).sort());
  });

  it("decodes each IDL event from its own discriminator, so none is unknown", () => {
    const lookup = core as unknown as Record<string, unknown>;
    for (const { name, discriminator } of idlEvents) {
      const decoder = (lookup[`get${name}EventDecoder`] as () => { fixedSize?: number })();
      const body = new Uint8Array(decoder.fixedSize ?? 256);
      body.set(discriminator);
      expect(lookup[`${screaming(name)}_EVENT_DISCRIMINATOR`], name).toEqual(new Uint8Array(discriminator));
      expect(decodeEvent(new Uint8Array([...EVENT_IX_TAG, ...body]))?.name, name).toBe(name);
    }
  });
});
