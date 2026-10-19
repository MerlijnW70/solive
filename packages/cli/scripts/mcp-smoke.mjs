import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { SMOKE_WAIT, SmokeFailed, SmokeUsage, serverArgs, smoke, smokeOptions, smokeWork } from "../dist/src/mcp-smoke.js";

const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const CALL_MS = 120_000;
const bin = fileURLToPath(new URL("../dist/src/bin.js", import.meta.url));

let options;
try {
  options = smokeOptions(process.argv.slice(2));
} catch (error) {
  if (error instanceof SmokeUsage) {
    console.error(error.message);
    process.exit(EXIT_USAGE);
  }
  throw error;
}

const page = await fetch(options.specUrl, { redirect: "error" }).catch((error) => {
  console.error(`the spec at ${options.specUrl} could not be fetched: ${error.message}`);
  process.exit(EXIT_FAILED);
});
if (!page.ok) {
  console.error(`the spec at ${options.specUrl} answered ${page.status}`);
  process.exit(EXIT_FAILED);
}
const specText = await page.text();

const clients = [];
async function party(key) {
  const client = new Client({ name: "mcp-smoke", version: "0.0.0" });
  clients.push(client);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, ...serverArgs(options.url)],
    env: { ...process.env, INTENT_ENGINE_KEYPAIR: resolve(key) },
    stderr: "ignore",
  });
  await client.connect(transport, { timeout: CALL_MS });
  return (name, args) => client.callTool({ name, arguments: args }, { timeout: CALL_MS });
}

let code = 0;
try {
  const hirer = await party(options.hirerKey);
  const worker = await party(options.workerKey);
  const work = smokeWork(options.specUrl, BigInt(Math.floor(Date.now() / 1000)));
  const result = await smoke({ hirer, worker }, { specUrl: options.specUrl, specText, workUrl: options.specUrl, work, wait: SMOKE_WAIT }, (line) => console.log(line));
  console.log(`release ${result.release}`);
} catch (error) {
  console.error(error instanceof SmokeFailed ? error.message : `mcp-smoke stopped: ${error instanceof Error ? error.message : String(error)}`);
  code = EXIT_FAILED;
} finally {
  await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
}
process.exit(code);
