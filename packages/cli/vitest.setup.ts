import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { defineConfig } from "vitest/config";

const chosen = process.env["FC_SEED"] ?? "42";

if (chosen !== "random") {
  const seed = Number(chosen);
  if (chosen.trim() === "" || !Number.isSafeInteger(seed)) {
    throw new Error(`FC_SEED must be an integer or random, not ${chosen}`);
  }
  fc.configureGlobal({ ...fc.readConfigureGlobal(), seed });
}

export default defineConfig({ test: { setupFiles: [fileURLToPath(import.meta.url)] } });
