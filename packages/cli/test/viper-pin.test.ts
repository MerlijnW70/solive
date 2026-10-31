import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VIPER_ENGINE_COMMIT, VIPER_WASM_SHA256 } from "../src/viper.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string) => readFileSync(`${ROOT}/${path}`);

describe("the pinned ViperJS judge", () => {
  it("names the engine commit the pin script builds", () => {
    const script = read("scripts/viper-judge.sh").toString("utf8");
    const pinned = /^commit=([0-9a-f]{40})$/m.exec(script)?.[1];
    expect(pinned).toBeDefined();
    expect(VIPER_ENGINE_COMMIT).toBe(pinned);
  });

  it("names the sha256 of the wasm it ships and of the pin record", () => {
    const wasm = createHash("sha256").update(read("packages/cli/assets/viperjs-judge.wasm")).digest("hex");
    expect(VIPER_WASM_SHA256).toBe(wasm);
    expect(read("packages/cli/assets/viperjs-judge.sha256").toString("utf8")).toContain(wasm);
  });
});
