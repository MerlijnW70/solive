import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createDefaultRpcTransport, createKeyPairSignerFromBytes, createSolanaRpcFromTransport, type KeyPairSigner } from "@solana/kit";
import { Kind } from "@intent-engine/core";
import { isSdkError } from "@intent-engine/client";
import { openUsb, pinnedFetch, readKeyFile, systemLookup } from "@intent-engine/client/node";
import { changesFrom, intentNotifications, limitedTransport, observedFetch, observedTransport, observerOf, type RpcLike, rpcTransport, signatureWatch } from "@intent-engine/client/internal";
import { type Command, DEFAULT_URL, ENV_URL, outputOf, parse, UsageError } from "./args.js";
import { follow, run, type Runtime, watchSolve } from "./commands.js";
import { withPriority } from "./compute.js";
import { JudgeInfraError, JudgeInterrupted } from "./judge.js";
import { watchJudge } from "./judge-watch.js";
import { addToLines, printable, printableLines, redactUrl, render, renderText } from "./render.js";
import { withSettings } from "./wallet.js";
import { ENV_KEYPAIR } from "./clusters.js";
import { certificateCode, certificateHint, maybeSentHint, SERVER_PROBLEMS, unfundedSend } from "./agent/problems.js";
import { WALLET_NOTICE } from "./agent/wallet.js";
import { EXIT_ALERTED } from "./monitor-args.js";
import { monitor, writeBaseline } from "./monitor.js";
import { launch } from "./launch.js";
import { rateLimitedHint, rpcCause } from "./rpc-failure.js";
import { checkLedgerPaths } from "./ledger-keys.js";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_PARTIAL = 3;
export { EXIT_ALERTED } from "./monitor-args.js";
export const KEYPAIR_UNREADABLE = "--keypair must name a readable JSON file holding a 64-byte keypair";
export const KEYPAIR_EXPOSED = "--keypair names a file other users can read or change; restrict it with chmod 600";

type Io = { out(text: string): void; err(text: string): void; tty?: boolean };

export { render } from "./render.js";

export const unreachable = (url: string) =>
  `cannot reach the RPC node at ${url}; check your network connection and that this endpoint is up, or pass another --url or set ${ENV_URL}`;

export const NO_NODE_SET = (url: string) => `no RPC node is set, so ${url} was tried and nothing answers there; run intent-engine setup, or pass --url devnet`;

export const PREVIEW_ONLY = "nothing was sent; pass --yes to sign and send it";

const PREVIEWED = new Set(["cancel", "expire", "close"]);

function partialFailure(command: Command, result: object | null): boolean {
  if (result === null) {
    return false;
  }
  if (command.name === "flow" && command.flow === "mandate-revoke") {
    return "failed" in result || "unknown" in result;
  }
  if (command.name === "migrate") {
    return "failed" in result && Array.isArray(result.failed) && result.failed.length > 0;
  }
  if (command.name === "crank") {
    return "actions" in result && Array.isArray(result.actions) && result.actions.some((action) => typeof action === "object" && action !== null && "error" in action);
  }
  return false;
}

export const ONE_NODE =
  "info: releases are checked against one RPC node; to check each release on a second node too, run intent-engine setup --confirm-url <rpc> once, or pass --confirm-url <rpc>";

export const readsOneNode = (command: Command): boolean =>
  (command.name === "judge" || command.name === "committee-release" || (command.name === "mcp" && command.wallet !== null)) && command.confirmUrl === undefined;

const offline = (error: unknown) => error instanceof TypeError && error.message === "fetch failed";

function message(error: unknown, url: string | undefined, unset: boolean): string {
  if (unfundedSend(error)) {
    return SERVER_PROBLEMS.Unfunded.hint;
  }
  const certificate = certificateCode(error);
  if (certificate !== null) {
    return certificateHint(url, certificate);
  }
  if (isSdkError(error, "confirm-mismatch")) {
    return printableLines(`${error.name}: ${error.message}`);
  }
  if (isSdkError(error, "maybe-sent")) {
    return printableLines(`${error.message}; ${maybeSentHint(error)}`);
  }
  const cause = rpcCause(error);
  if (cause?.kind === "http" && cause.status === 429) {
    return rateLimitedHint(url);
  }
  if (url !== undefined && offline(error)) {
    return unset ? NO_NODE_SET(redactUrl(url)) : unreachable(redactUrl(url));
  }
  return printableLines(error instanceof Error ? error.message : String(error));
}

export const debugOf = (argv: readonly string[]): boolean => argv.includes("--debug");

export function debugged(runtime: Runtime, write: (line: string) => void): Runtime {
  const observer = observerOf({}, (line) => write(printable(line)));
  return {
    ...runtime,
    transport: (url) => observedTransport(runtime.transport(url), observer),
    specFetch: observedFetch(runtime.specFetch, observer),
  };
}

export async function main(argv: readonly string[], runtime: Runtime, io: Io): Promise<number> {
  let url: string | undefined;
  let unset = false;
  try {
    const settings = await withSettings(runtime, runtime.env);
    const command = parse(argv, settings);
    const live = debugOf(argv) ? debugged(runtime, io.err) : runtime;
    url = "url" in command ? command.url : undefined;
    unset = url === DEFAULT_URL && settings[ENV_URL] === undefined && !argv.some((arg) => arg === "--url" || arg.startsWith("--url="));
    checkLedgerPaths(command, settings[ENV_KEYPAIR]);
    if (readsOneNode(command)) {
      process.stderr.write(`${ONE_NODE}\n`);
    }
    const show = (value: object) =>
      io.out(
        command.name === "add-to" && io.tty === true
          ? addToLines(value)
          : command.name === "help" || outputOf(argv) === "text"
            ? renderText(value)
            : render(value),
      );
    if (command.name === "follow") {
      const transport = withPriority(live.transport(command.url), command.priority);
      await follow(transport, live, command.limit, command.interval, show);
      return EXIT_OK;
    }
    if (command.name === "monitor") {
      const transport = live.transport(command.url);
      if (command.watch === null) {
        show(await writeBaseline(command.baseline, live, transport));
        return EXIT_OK;
      }
      return (await monitor(command.url, command.baseline, command.watch, live, transport, io)) > 0 ? EXIT_ALERTED : EXIT_OK;
    }
    if (command.name === "solve" && command.watch !== null) {
      await watchSolve(command, command.watch, live, show);
      return EXIT_OK;
    }
    if (command.name === "judge" && command.watch !== null) {
      return await watchJudge(command, command.watch, live, withPriority(live.transport(command.url), command.priority), io.out);
    }
    if (command.name === "mcp" && command.wallet !== null) {
      io.err(WALLET_NOTICE.join("\n"));
    }
    const result = await run(command, live);
    if (result !== null) {
      show(result);
    }
    if (PREVIEWED.has(command.name) && result !== null && "sent" in result && result.sent === false) {
      io.err(PREVIEW_ONLY);
    }
    if (partialFailure(command, result)) {
      return EXIT_PARTIAL;
    }
    if (command.name === "sandbox-doctor" && result !== null && "ready" in result && result.ready !== true) {
      return EXIT_FAILED;
    }
    return command.name === "judge" && result !== null && "verdict" in result && result.verdict !== "pass" ? EXIT_FAILED : EXIT_OK;
  } catch (error) {
    io.err(message(error, url, unset));
    if (error instanceof JudgeInterrupted || error instanceof JudgeInfraError) {
      return error.exitCode;
    }
    return error instanceof UsageError ? EXIT_USAGE : EXIT_FAILED;
  }
}

const keyLike = (path: string) => /^[1-9A-HJ-NP-Za-km-z]{32,}$/.test(path) || path.trimStart().startsWith("[");

export const keypairUnreadable = (path: string) =>
  keyLike(path) ? `${KEYPAIR_UNREADABLE}; the value given looks like a key, not a file path, so it is not repeated here` : `${KEYPAIR_UNREADABLE}; tried ${path}`;

export async function loadKeypairBytes(path: string, platform: string = process.platform, home: string = homedir()): Promise<Uint8Array> {
  const read = await readKeyFile(path, platform, home);
  if ("bytes" in read) {
    return read.bytes;
  }
  throw new UsageError(read.problem === "exposed" ? KEYPAIR_EXPOSED : keypairUnreadable(read.file));
}

export const loadKeypairFile = async (path: string, platform: string = process.platform, home: string = homedir()): Promise<KeyPairSigner> =>
  createKeyPairSignerFromBytes(await loadKeypairBytes(path, platform, home));

type Pipes = { stdin: Readable; stdout: Writable };

export const FETCH_TIMEOUT_MS = 10_000;

export const RPC_REQUEST_MS = 30_000;

export const timedRpc = (url: string, timeoutMs: number = RPC_REQUEST_MS): RpcLike =>
  createSolanaRpcFromTransport(limitedTransport(createDefaultRpcTransport({ url }), timeoutMs, undefined)) as unknown as RpcLike;

export function nodeRuntime(clock: () => number = Date.now, pipes: Pipes = process, timeoutMs = FETCH_TIMEOUT_MS): Runtime {
  return {
    transport: (url) => rpcTransport(timedRpc(url), undefined, signatureWatch(url)),
    intentChanges: (url) => changesFrom(intentNotifications(url)),
    jobChanges: (url) => changesFrom(intentNotifications(url, Kind.AttestedResult)),
    loadSigner: loadKeypairFile,
    loadKeypair: loadKeypairBytes,
    specFetch: pinnedFetch,
    lookup: systemLookup,
    readText: (path) => readFile(path, "utf8"),
    sleep: (seconds, stop) =>
      new Promise((resolve) => {
        if (stop?.aborted === true) {
          resolve(false);
          return;
        }
        const timer = setTimeout(() => resolve(true), seconds * 1000);
        stop?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve(false);
          },
          { once: true },
        );
      }),
    env: process.env,
    writeText: (path, text) => writeFile(path, text, { flag: "wx" }),
    saveText: async (path, text, secret) => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, text, secret ? { flag: "wx", mode: 0o600 } : { mode: 0o600 });
    },
    removeFile: (path) => rm(path),
    home: homedir().replaceAll("\\", "/"),
    now: () => BigInt(Math.floor(clock() / 1000)),
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
    faucetFetch: (url, init) => fetch(url, init),
    entropy: () => crypto.getRandomValues(new Uint32Array(1))[0] ?? 0,
    serve: async (server) => {
      const ended = new Promise<void>((resolve) => pipes.stdin.once("end", () => resolve()));
      await server.connect(new StdioServerTransport(pipes.stdin, pipes.stdout));
      await ended;
      await server.close();
    },
    platform: process.platform,
    launch: (program, args, timeoutMs) => launch(program, args, process.platform, timeoutMs),
    ledger: openUsb,
  };
}

type ProcessLike = {
  argv: readonly string[];
  stdout: { write(text: string): unknown; isTTY?: boolean };
  stderr: { write(text: string): unknown };
};

export async function runProcess(proc: ProcessLike, runtime: Runtime = nodeRuntime()): Promise<number> {
  return main(proc.argv.slice(2), runtime, {
    out: (text) => proc.stdout.write(`${text}\n`),
    err: (text) => proc.stderr.write(`${text}\n`),
    tty: proc.stdout.isTTY === true,
  });
}
