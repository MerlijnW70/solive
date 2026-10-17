import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LEDGER_ERRORS, LedgerError, ledgerModule } from "../src/index.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Record<string, Record<string, unknown> | undefined>;
const LEDGER = ["@ledgerhq/hw-app-solana", "@ledgerhq/hw-transport-node-hid-noevents"];

describe("the Ledger libraries", () => {
  it("are optional peers, so installing the client never installs them or their native driver", () => {
    for (const name of LEDGER) {
      expect(manifest["dependencies"]?.[name]).toBeUndefined();
      expect(manifest["optionalDependencies"]?.[name]).toBeUndefined();
      expect(manifest["peerDependenciesMeta"]?.[name]).toEqual({ optional: true });
      expect(manifest["peerDependencies"]?.[name]).toMatch(/^\d+\.\d+\.\d+$/);
      expect(manifest["devDependencies"]?.[name]).toBe(manifest["peerDependencies"]?.[name]);
    }
  });

  it("are named with their versions when missing, and other load errors pass through", () => {
    const missing = Object.assign(new Error("Cannot find module"), { code: "MODULE_NOT_FOUND" });
    expect(() =>
      ledgerModule(LEDGER[0] ?? "", () => {
        throw missing;
      }),
    ).toThrow(new LedgerError(LEDGER_ERRORS.missing));
    for (const name of LEDGER) {
      expect(LEDGER_ERRORS.missing).toContain(`${name}@${String(manifest["peerDependencies"]?.[name])}`);
    }
    const broken = new Error("bindings file not found");
    expect(() =>
      ledgerModule(LEDGER[0] ?? "", () => {
        throw broken;
      }),
    ).toThrow(broken);
    expect(ledgerModule("x", () => 7)).toBe(7);
  });
});
