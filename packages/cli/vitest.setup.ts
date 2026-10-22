import { availableParallelism, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { defineConfig } from "vitest/config";

const chosen = process.env["FC_SEED"] ?? "42";
const WORKER_CAP = 8;
const BYTES_PER_WORKER = 2 * 1024 ** 3;

export const workers = Math.max(1, Math.min(WORKER_CAP, availableParallelism() - 1, Math.floor(totalmem() / BYTES_PER_WORKER)));

if (chosen !== "random") {
  const seed = Number(chosen);
  if (chosen.trim() === "" || !Number.isSafeInteger(seed)) {
    throw new Error(`FC_SEED must be an integer or random, not ${chosen}`);
  }
  fc.configureGlobal({ ...fc.readConfigureGlobal(), seed });
}

export default defineConfig({ test: { setupFiles: [fileURLToPath(import.meta.url)], maxWorkers: workers, execArgv: ["--expose-gc"] } });
