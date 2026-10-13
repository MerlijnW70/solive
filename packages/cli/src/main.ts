import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createKeyPairSignerFromBytes, createSolanaRpc, type KeyPairSigner } from "@solana/kit";
import { changesFrom, intentNotifications, type RpcLike, rpcTransport, signatureWatch } from "@intent-engine/client";
import { ENV_URL, outputOf, parse, UsageError } from "./args.js";
import { follow, run, type Runtime, watchSolve } from "./commands.js";
import { withPriority } from "./compute.js";
import { printableLines, render, renderText } from "./render.js";
import { withSettings } from "./wallet.js";
import { WALLET_NOTICE } from "./agent/wallet.js";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const KEYPAIR_UNREADABLE = "--keypair must name a readable JSON file holding a 64-byte keypair";
export const KEYPAIR_EXPOSED = "--keypair names a file other users can read or change; restrict it with chmod 600";

type Io = { out(text: string): void; err(text: string): void };

export { render } from "./render.js";

export const unreachable = (url: string) =>
  `cannot reach the RPC node at ${url}; pass --url devnet, --url mainnet-beta or an https URL, or set ${ENV_URL}`;

const offline = (error: unknown) => error instanceof TypeError && error.message === "fetch failed";

function message(error: unknown, url: string | undefined): string {
  if (url !== undefined && offline(error)) {
    return unreachable(url);
  }
  return printableLines(error instanceof Error ? error.message : String(error));
}

export async function main(argv: readonly string[], runtime: Runtime, io: Io): Promise<number> {
  let url: string | undefined;
  try {
    const command = parse(argv, await withSettings(runtime, runtime.env));
    url = "url" in command ? command.url : undefined;
    const show = (value: object) => io.out(command.name === "help" || outputOf(argv) === "text" ? renderText(value) : render(value));
    if (command.name === "follow") {
      const transport = withPriority(runtime.transport(command.url), command.priority);
      await follow(transport, runtime, command.limit, command.interval, show);
      return EXIT_OK;
    }
    if (command.name === "solve" && command.watch !== null) {
      await watchSolve(command, command.watch, runtime, show);
      return EXIT_OK;
    }
    if (command.name === "mcp" && command.wallet !== null) {
      io.err(WALLET_NOTICE.join("\n"));
    }
    const result = await run(command, runtime);
    if (result !== null) {
      show(result);
    }
    return command.name === "judge" && result !== null && "verdict" in result && result.verdict !== "pass" ? EXIT_FAILED : EXIT_OK;
  } catch (error) {
    io.err(message(error, url));
    return error instanceof UsageError ? EXIT_USAGE : EXIT_FAILED;
  }
}

export async function loadKeypairFile(path: string, platform: string = process.platform): Promise<KeyPairSigner> {
  let bytes: unknown;
  let mode: number;
  try {
    mode = (await stat(path)).mode;
    bytes = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new UsageError(KEYPAIR_UNREADABLE);
  }
  if (platform !== "win32" && (mode & 0o077) !== 0) {
    throw new UsageError(KEYPAIR_EXPOSED);
  }
  if (
    !Array.isArray(bytes) ||
    bytes.length !== 64 ||
    !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)
  ) {
    throw new UsageError(KEYPAIR_UNREADABLE);
  }
  return createKeyPairSignerFromBytes(new Uint8Array(bytes));
}

type Pipes = { stdin: Readable; stdout: Writable };

export const FETCH_TIMEOUT_MS = 10_000;

export function nodeRuntime(clock: () => number = Date.now, pipes: Pipes = process, timeoutMs = FETCH_TIMEOUT_MS): Runtime {
  return {
    transport: (url) => rpcTransport(createSolanaRpc(url) as unknown as RpcLike, undefined, signatureWatch(url)),
    intentChanges: (url) => changesFrom(intentNotifications(url)),
    loadSigner: loadKeypairFile,
    readText: (path) => readFile(path, "utf8"),
    sleep: (seconds) => new Promise((resolve) => setTimeout(() => resolve(true), seconds * 1000)),
    env: process.env,
    writeText: (path, text) => writeFile(path, text, { flag: "wx" }),
    saveText: async (path, text, secret) => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, text, secret ? { flag: "wx", mode: 0o600 } : { mode: 0o600 });
    },
    home: homedir().replaceAll("\\", "/"),
    now: () => BigInt(Math.floor(clock() / 1000)),
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
    entropy: () => crypto.getRandomValues(new Uint32Array(1))[0] ?? 0,
    serve: async (server) => {
      const ended = new Promise<void>((resolve) => pipes.stdin.once("end", () => resolve()));
      await server.connect(new StdioServerTransport(pipes.stdin, pipes.stdout));
      await ended;
      await server.close();
    },
  };
}

type ProcessLike = {
  argv: readonly string[];
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
};

export async function runProcess(proc: ProcessLike, runtime: Runtime = nodeRuntime()): Promise<number> {
  return main(proc.argv.slice(2), runtime, {
    out: (text) => proc.stdout.write(`${text}\n`),
    err: (text) => proc.stderr.write(`${text}\n`),
  });
}
