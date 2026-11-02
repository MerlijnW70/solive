import { availableParallelism, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const WORKER_CAP = 8;
const BYTES_PER_WORKER = 2 * 1024 ** 3;

export const workers = Math.max(1, Math.min(WORKER_CAP, availableParallelism() - 1, Math.floor(totalmem() / BYTES_PER_WORKER)));

export default defineConfig({ test: { setupFiles: [fileURLToPath(new URL("../cli/test/faucet-setup.ts", import.meta.url))], maxWorkers: workers, execArgv: ["--expose-gc"] } });
