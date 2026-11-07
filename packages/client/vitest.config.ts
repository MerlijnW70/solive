import { availableParallelism, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../..", import.meta.url));
const CLI_TEST = join(ROOT, "packages", "cli", "test");
const WORKER_CAP = 8;
const BYTES_PER_WORKER = 2 * 1024 ** 3;

export const workers = Math.max(1, Math.min(WORKER_CAP, availableParallelism() - 1, Math.floor(totalmem() / BYTES_PER_WORKER)));

export default defineConfig({ test: { globalSetup: [join(CLI_TEST, "run-root-setup.ts")], setupFiles: [join(CLI_TEST, "faucet-setup.ts")], maxWorkers: workers, execArgv: ["--expose-gc"] } });
