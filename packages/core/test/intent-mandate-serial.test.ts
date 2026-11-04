import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACCOUNT_LAYOUTS, decodeIntentAccount, INTENT_VERSION } from "../src/internal.js";

const LAYOUT_RS = readFileSync(fileURLToPath(new URL("../../../tests/svm/tests/layout.rs", import.meta.url)), "utf8");
const frozen = (field: string): number => {
  const found = LAYOUT_RS.match(new RegExp(`offset_of!\\(Intent, ${field}\\), (\\d+)\\)`));
  if (found?.[1] === undefined) throw new Error(`layout.rs pins no offset for Intent.${field}`);
  return Number(found[1]);
};

describe("a decoded intent carries the mandate serial the program stored", () => {
  it("reads mandateSerial from the offset the Rust layout test pins", () => {
    const layout = ACCOUNT_LAYOUTS.find((l) => l.name === "intent");
    if (layout === undefined) throw new Error("no intent layout");
    const data = new Uint8Array(layout.space);
    data.set(layout.discriminator, 0);
    data[8 + layout.versionAt] = INTENT_VERSION;
    const view = new DataView(data.buffer);
    view.setBigUint64(8 + frozen("mandate_serial"), 0x0102_0304_0506_0708n, true);
    view.setBigUint64(8 + frozen("mandate_serial") + 8, 77n, true);
    const intent = decodeIntentAccount(data);
    expect(intent.mandateSerial).toBe(0x0102_0304_0506_0708n);
    expect(intent.agentFee).toBe(77n);
  });
});
