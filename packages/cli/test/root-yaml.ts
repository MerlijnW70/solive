import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const yaml = createRequire(join(ROOT, "package.json"))("yaml") as typeof import("yaml");

export const parse = yaml.parse;
