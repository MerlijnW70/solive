import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { defineConfig } from "vitest/config";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../..", import.meta.url));
const CLI_TEST = join(ROOT, "packages", "cli", "test");
const chosen = process.env["FC_SEED"] ?? "42";

if (chosen !== "random") {
  const seed = Number(chosen);
  if (chosen.trim() === "" || !Number.isSafeInteger(seed)) {
    throw new Error(`FC_SEED must be an integer or random, not ${chosen}`);
  }
  fc.configureGlobal({ ...fc.readConfigureGlobal(), seed });
}

export default defineConfig({ test: { globalSetup: [join(CLI_TEST, "run-root-setup.ts")], setupFiles: [fileURLToPath(import.meta.url)] } });
