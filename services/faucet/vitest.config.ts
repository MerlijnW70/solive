import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { globalSetup: [fileURLToPath(new URL("../../packages/cli/test/run-root-setup.ts", import.meta.url))] } });
