import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as DemoWorker from "../../../scripts/demo-worker.mjs";

export type { Cli, Demo, DemoJob, Event, Found, Rpc, Settings, Socket } from "../../../scripts/demo-worker.mjs";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));

export const worker = (await import(pathToFileURL(join(ROOT, "scripts", "demo-worker.mts")).href)) as typeof DemoWorker;
