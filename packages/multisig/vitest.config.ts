import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../..", import.meta.url));
const CLI_TEST = join(ROOT, "packages", "cli", "test");

export default defineConfig({ test: { globalSetup: [join(CLI_TEST, "run-root-setup.ts")] } });
