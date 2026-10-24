import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { feeBpsFor, formatAmount, Kind, parseAmount, splitFees } from "@intent-engine/core";
import { DEVNET_FEES } from "../src/testing.js";
import { TESTING_SECTION } from "./doc-sections.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const SECTION = TESTING_SECTION.exec(readFileSync(`${ROOT}/docs/sdk-client.md`, "utf8"))?.[0] ?? "";
const BLOCKS = [...SECTION.matchAll(/^```ts\n([\s\S]*?)^```$/gm)].map((m) => m[1] ?? "");
const PRINTED = [...SECTION.matchAll(/\bprints `([^`]+)`/g)].map((m) => m[1] ?? "");
const ENTRY = { "@intent-engine/client/testing": "../src/testing.js", "@intent-engine/client/svm": "../src/svm.js", "@intent-engine/client": "../src/index.js" };
const pageModule = fileURLToPath(new URL(`./.testing-page-${process.pid}.ts`, import.meta.url));

const local = (code: string): string =>
  Object.entries(ENTRY).reduce((text, [name, path]) => text.replaceAll(`"${name}"`, JSON.stringify(path)), code);

describe("the Testing section of the client page", () => {
  const engine = process.env["INTENT_ENGINE_SO"];

  afterEach(() => {
    if (engine === undefined) {
      delete process.env["INTENT_ENGINE_SO"];
    } else {
      process.env["INTENT_ENGINE_SO"] = engine;
    }
    rmSync(pageModule, { force: true });
  });

  it("has one example, names the entry points and tells Windows readers to use WSL", () => {
    expect(BLOCKS).toHaveLength(1);
    expect(BLOCKS[0]).toContain('from "@intent-engine/client/testing"');
    expect(SECTION).toContain("`svmTransport(svm)` from `@intent-engine/client/svm`");
    expect(SECTION).toContain("on Windows, run it in WSL");
    expect(PRINTED).toHaveLength(1);
  });

  it("states devnet's fee on proof escrows as the world configures it", () => {
    const percent = feeBpsFor(DEVNET_FEES, Kind.AttestedResult);
    expect(SECTION).toContain(`after devnet's ${percent / 100}% fee on proof escrows`);
  });

  it("runs the example against the shipped program with INTENT_ENGINE_SO unset and prints the worker's pay", { timeout: 120_000 }, async () => {
    delete process.env["INTENT_ENGINE_SO"];
    const printed: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    });
    writeFileSync(pageModule, local(BLOCKS.join("\n")));
    try {
      await import(pathToFileURL(pageModule).href);
    } finally {
      log.mockRestore();
    }
    const { net } = splitFees(parseAmount("0.5", 9), feeBpsFor(DEVNET_FEES, Kind.AttestedResult), 0, DEVNET_FEES.partnerCutBps);
    expect(printed).toEqual([formatAmount(net, 9)]);
    expect(printed).toEqual(PRINTED);
  });
});
