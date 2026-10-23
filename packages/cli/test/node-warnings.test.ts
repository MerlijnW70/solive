import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isWebCryptoExperimental, quietWebCryptoWarnings, type WarningSource } from "../src/node-warnings.js";

const named = (name: string, message: string) => Object.assign(new Error(message), { name });
const experimental = (algorithm: string) => named("ExperimentalWarning", `The ${algorithm} Web Crypto API algorithm is an experimental feature and might change at any time`);

describe("node warnings the cli hides", () => {
  it("hides only the X25519 and Ed25519 experimental warnings and passes every other warning on", () => {
    const source = new EventEmitter();
    const shown: string[] = [];
    source.on("warning", (warning: Error) => shown.push(`${warning.name}: ${warning.message}`));
    quietWebCryptoWarnings(source as unknown as WarningSource);
    source.emit("warning", experimental("X25519"));
    source.emit("warning", experimental("Ed25519"));
    source.emit("warning", named("ExperimentalWarning", "The Fetch API is an experimental feature"));
    source.emit("warning", named("DeprecationWarning", "X25519 is deprecated"));
    expect(shown).toEqual(["ExperimentalWarning: The Fetch API is an experimental feature", "DeprecationWarning: X25519 is deprecated"]);
  });

  it("tells the two algorithm warnings apart from other experimental warnings", () => {
    expect(isWebCryptoExperimental(experimental("X25519"))).toBe(true);
    expect(isWebCryptoExperimental(experimental("Ed25519"))).toBe(true);
    expect(isWebCryptoExperimental(experimental("X448"))).toBe(false);
    expect(isWebCryptoExperimental(named("Warning", experimental("X25519").message))).toBe(false);
  });

  it("is installed by the cli entry point before anything runs", () => {
    const bin = readFileSync(new URL("../src/bin.ts", import.meta.url), "utf8");
    expect(bin.indexOf("quietWebCryptoWarnings();")).toBeGreaterThan(-1);
    expect(bin.indexOf("quietWebCryptoWarnings();")).toBeLessThan(bin.indexOf("runProcess(process)"));
  });
});
