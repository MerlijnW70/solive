import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getBase58Decoder } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEVNET_TEST_MINT, feeBpsFor, formatAmount, Kind, NATIVE_MINT, parseAmount, splitFees } from "@intent-engine/core";
import { DEVNET_FEES, createTestWorld, shippedProgram } from "../src/testing.js";
import { TESTING_SECTION } from "./doc-sections.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const SECTION = TESTING_SECTION.exec(readFileSync(`${ROOT}/docs/sdk-client.md`, "utf8"))?.[0] ?? "";
const BLOCKS = [...SECTION.matchAll(/^```ts\n([\s\S]*?)^```$/gm)].map((m) => m[1] ?? "");
const SHELL = [...SECTION.matchAll(/^```sh\n([\s\S]*?)^```$/gm)].map((m) => m[1] ?? "");
const PRINTED = [...SECTION.matchAll(/\bprints `([^`]+)`/g)].map((m) => m[1] ?? "");
const ENTRY = { "@intent-engine/client/testing": "../src/testing.js", "@intent-engine/client/svm": "../src/svm.js", "@intent-engine/client": "../src/index.js" };
const MANIFEST = JSON.parse(readFileSync(`${ROOT}/packages/client/package.json`, "utf8")) as {
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
};
const OPTIONS =
  "Its options are `start`, the clock's first unix time; `fees`, which replace devnet's; `program`, other program bytes; `domain`, the 32 bytes it reports as the genesis hash and sets as the engine's domain, devnet's by default; `url`, the RPC url its client reports, devnet's by default, which it never reaches; `devnetMints: false`, which leaves out the wrapped SOL and test mints; and `hooks` and `debug`, as in [Observe](#observe).";
const pageModule = (at: number) => fileURLToPath(new URL(`./.testing-page-${process.pid}-${at}.ts`, import.meta.url));

const local = (code: string): string =>
  Object.entries(ENTRY).reduce((text, [name, path]) => text.replaceAll(`"${name}"`, JSON.stringify(path)), code);

async function printedBy(code: string, at: number): Promise<string[]> {
  const printed: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  });
  writeFileSync(pageModule(at), local(code));
  try {
    await import(pathToFileURL(pageModule(at)).href);
  } finally {
    log.mockRestore();
  }
  return printed;
}

describe("the Testing section of the client page", () => {
  const engine = process.env["INTENT_ENGINE_SO"];

  afterEach(() => {
    if (engine === undefined) {
      delete process.env["INTENT_ENGINE_SO"];
    } else {
      process.env["INTENT_ENGINE_SO"] = engine;
    }
    BLOCKS.forEach((_, at) => rmSync(pageModule(at), { force: true }));
  });

  it("has two examples, names the entry points and tells Windows readers to use WSL", () => {
    expect(BLOCKS).toHaveLength(2);
    for (const block of BLOCKS) {
      expect(block).toContain('from "@intent-engine/client/testing"');
    }
    expect(SECTION).toContain("`svmTransport(svm)` from `@intent-engine/client/svm`");
    expect(SECTION).toContain("on Windows, run it in WSL");
    expect(PRINTED).toHaveLength(3);
  });

  it("installs litesvm in the range the client accepts, since npm leaves an optional peer out", () => {
    expect(MANIFEST.peerDependenciesMeta["litesvm"]?.optional).toBe(true);
    expect(SHELL).toEqual([`npm install --save-dev litesvm@${MANIFEST.peerDependencies["litesvm"]}\n`]);
    expect(SECTION).toContain("It needs the `litesvm` package, an optional peer of the client that npm does not install for you");
  });

  it(OPTIONS, async () => {
    expect(SECTION).toContain(`- ${OPTIONS}`);
    const domain = new Uint8Array(32).fill(9);
    const url = "https://" + "rpc.example";
    const lines: string[] = [];
    const world = await createTestWorld({ start: 1_700_000_000n, fees: { feeBps: 7 }, program: shippedProgram(), domain, url, devnetMints: false, debug: (line) => void lines.push(line) });
    expect(world.now()).toBe(1_700_000_000n);
    expect(world.fees.feeBps).toBe(7);
    expect(await world.transport.genesisHash()).toBe(getBase58Decoder().decode(domain));
    expect(Uint8Array.from((await world.client.config()).domain)).toEqual(domain);
    expect(world.client.url).toBe(url);
    expect(world.svm.getAccount(NATIVE_MINT).exists).toBe(false);
    expect(world.svm.getAccount(DEVNET_TEST_MINT).exists).toBe(false);
    await world.client.config();
    expect(lines.length).toBeGreaterThan(0);
  });

  it("states devnet's fee on proof escrows as the world configures it", () => {
    const percent = feeBpsFor(DEVNET_FEES, Kind.AttestedResult);
    expect(SECTION).toContain(`after devnet's ${percent / 100}% fee on proof escrows`);
  });

  it("runs the first example against the shipped program with INTENT_ENGINE_SO unset and prints the worker's pay", { timeout: 120_000 }, async () => {
    delete process.env["INTENT_ENGINE_SO"];
    const { net } = splitFees(parseAmount("0.5", 9), feeBpsFor(DEVNET_FEES, Kind.AttestedResult), 0, DEVNET_FEES.partnerCutBps);
    expect(await printedBy(BLOCKS[0] ?? "", 0)).toEqual([formatAmount(net, 9)]);
    expect(PRINTED[0]).toBe(formatAmount(net, 9));
  });

  it("runs the second example, which posts with a local spec url, lists it with jobs, reads it with spec, delivers, and judges with openings and settleProof", { timeout: 120_000 }, async () => {
    const code = BLOCKS[1] ?? "";
    for (const call of ["specUrl: local", "world.client.jobs(", "world.client.spec(", "world.client.announce(", "world.client.openings(", "world.client.settleProof("]) {
      expect(code).toContain(call);
    }
    const { net } = splitFees(parseAmount("0.49", 9), feeBpsFor(DEVNET_FEES, Kind.AttestedResult), 0, DEVNET_FEES.partnerCutBps);
    expect(await printedBy(code, 1)).toEqual([`true ${formatAmount(net, 9)}`, formatAmount(net, 9)]);
    expect(PRINTED.slice(1)).toEqual([`true ${formatAmount(net, 9)}`, formatAmount(net, 9)]);
  });
});
