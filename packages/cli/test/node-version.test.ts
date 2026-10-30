import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nodeTooOld, oldNodeMessage, REQUIRED_NODE } from "../src/bin.js";

const ENGINE = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { engines: { node: string } }).engines.node;

function stubNode(version: string): void {
  Object.defineProperty(process.versions, "node", { value: version, configurable: true });
}

describe("the Node.js version check at start", () => {
  const real = process.versions.node;
  const realCode = process.exitCode;

  afterEach(() => {
    stubNode(real);
    process.exitCode = realCode;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("requires what package.json requires", () => {
    expect(ENGINE).toBe(`>=${REQUIRED_NODE}`);
  });

  it("orders versions numerically", () => {
    expect(nodeTooOld("20.19.0")).toBe(true);
    expect(nodeTooOld("22.11.9")).toBe(true);
    expect(nodeTooOld("22.12.0")).toBe(false);
    expect(nodeTooOld("22.100.0")).toBe(false);
    expect(nodeTooOld("24.0.0")).toBe(false);
  });

  it("prints one sentence with both versions and the download link, and exits 1, on an old Node.js", async () => {
    stubNode("18.20.4");
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((text) => {
      written.push(String(text));
      return true;
    });
    vi.resetModules();
    await import("../src/bin.js");
    expect(written).toEqual([`${oldNodeMessage("18.20.4")}\n`]);
    expect(written[0]).toContain("18.20.4");
    expect(written[0]).toContain(REQUIRED_NODE);
    expect(written[0]).toContain("https://" + "nodejs.org/en/download");
    expect(process.exitCode).toBe(1);
  });
});
