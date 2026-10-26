import { claimsOf } from "../src/agent/claims.js";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { testSignature } from "@intent-engine/client/testing";
import { findIntentPda, getPauseRaisedEventEncoder, getUserInitializedEventEncoder, findVaultPda, EVENT_IX_TAG } from "@intent-engine/core/internal";
import { agentServer } from "../src/agent/mcp.js";
import { ACTIONS } from "../src/agent/registry.js";
import { UsageError } from "../src/args.js";
import { expandHome } from "../src/wallet.js";
import { run, STATUS } from "../src/commands.js";
import {
  EXIT_OK,
  EXIT_USAGE,
  FETCH_TIMEOUT_MS,
  KEYPAIR_EXPOSED,
  KEYPAIR_UNREADABLE,
  keypairUnreadable,
  loadKeypairFile,
  nodeRuntime,
  render,
  runProcess,
} from "../src/main.js";
import { cli, h, runtime, transport } from "./harness.js";

describe("process plumbing", () => {
  it("renders bigints as decimal strings and bytes as hex", () => {
    expect(render({ a: 1n, b: new Uint8Array([0, 255]), c: "x" })).toBe('{\n  "a": "1",\n  "b": "00ff",\n  "c": "x"\n}');
  });

  it("names every lifecycle status in order", () => {
    expect(STATUS).toEqual(["open", "filled", "cancelled", "expired", "filling"]);
  });

  it("loads a solana keypair file and rejects anything else", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cli-"));
    const seed = new Uint8Array(32).fill(7);
    seed[0] = 0;
    seed[1] = 255;
    const kp = await createKeyPairSignerFromPrivateKeyBytes(seed);
    const good = join(dir, "good.json");
    const secret = new Uint8Array(64);
    secret.set(seed);
    secret.set(getAddressEncoder().encode(kp.address), 32);
    await writeFile(good, JSON.stringify([...secret]), { mode: 0o600 });
    expect((await loadKeypairFile(good)).address).toBe(kp.address);
    for (const mode of [0o640, 0o604, 0o620, 0o602, 0o700, 0o400]) {
      const path = join(dir, `mode-${mode.toString(8)}.json`);
      await writeFile(path, JSON.stringify([...secret]), { mode });
      await chmod(path, mode);
      if ((mode & 0o077) === 0) {
        expect((await loadKeypairFile(path)).address).toBe(kp.address);
      } else {
        await expect(loadKeypairFile(path)).rejects.toThrow(KEYPAIR_EXPOSED);
        expect((await loadKeypairFile(path, "win32")).address).toBe(kp.address);
      }
    }
    for (const [name, body] of [
      ["short", JSON.stringify([...secret.subarray(0, 63)])],
      ["large", JSON.stringify([...secret.subarray(0, 63), 256])],
      ["negative", JSON.stringify([...secret.subarray(0, 63), -1])],
      ["fraction", JSON.stringify([...secret.subarray(0, 63), 1.5])],
      ["object", JSON.stringify({ length: 64 })],
    ] as const) {
      const path = join(dir, `${name}.json`);
      await writeFile(path, body, { mode: 0o600 });
      await expect(loadKeypairFile(path)).rejects.toThrow(KEYPAIR_UNREADABLE);
    }
    const garbled = join(dir, "garbled.json");
    await writeFile(garbled, "{", { mode: 0o600 });
    await expect(loadKeypairFile(garbled)).rejects.toBeInstanceOf(UsageError);
    const secret58 = "4hZ".repeat(29);
    const phantom = join(dir, "phantom.txt");
    await writeFile(phantom, secret58, { mode: 0o600 });
    for (const target of [phantom, secret58, join(dir, "absent.json"), JSON.stringify([...secret])]) {
      const failure = await loadKeypairFile(target).then(
        () => "loaded",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect(failure).toBe(keypairUnreadable(target));
      expect(failure.startsWith(KEYPAIR_UNREADABLE)).toBe(true);
      expect(failure).not.toContain("4hZ");
      expect(failure).not.toContain("[");
    }
    expect(keypairUnreadable(phantom)).toBe(`${KEYPAIR_UNREADABLE}; tried ${phantom}`);
    expect(keypairUnreadable(secret58)).not.toContain(secret58);
  });

  it("a keypair path starting with a tilde is expanded", async () => {
    const home = await mkdtemp(join(tmpdir(), "home-"));
    const seed = new Uint8Array(32).fill(9);
    const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
    await writeFile(join(home, "wallet.json"), JSON.stringify([...seed, ...getAddressEncoder().encode(signer.address)]), { mode: 0o600 });
    expect((await loadKeypairFile("~/wallet.json", process.platform, home)).address).toBe(signer.address);
    expect((await loadKeypairFile(join(home, "wallet.json"), process.platform, home)).address).toBe(signer.address);
    const missing = await loadKeypairFile("~/absent.json", process.platform, home).then(
      () => "loaded",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(missing).toBe(`${KEYPAIR_UNREADABLE}; tried ${home}/absent.json`);
    expect(expandHome("~", home)).toBe(home);
    expect(expandHome("~\\wallet.json", home)).toBe(`${home}\\wallet.json`);
    expect(expandHome("~other/wallet.json", home)).toBe("~other/wallet.json");
    expect(expandHome("a/~/wallet.json", home)).toBe("a/~/wallet.json");
  });

  it("serves the agent tools over stdio until the client hangs up", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const replies: Record<string, unknown>[] = [];
    let buffered = "";
    stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      replies.push(...lines.filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, unknown>));
    });
    const rt = nodeRuntime(Date.now, { stdin, stdout });
    const served = rt.serve(agentServer({ transport, relay: undefined, agent: undefined, claims: claimsOf() }));
    const ask = (id: number, method: string, params: object) =>
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    ask(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    ask(2, "tools/list", {});
    await vi.waitFor(() => expect(replies.map((r) => r["id"])).toEqual([1, 2]));
    expect(replies[0]?.["result"]).toMatchObject({ serverInfo: { name: "solive" } });
    expect((replies[1]?.["result"] as { tools: unknown[] }).tools).toHaveLength(ACTIONS.length);
    stdin.end();
    await expect(served).resolves.toBeUndefined();
  });

  it("gives up on an http request that never answers instead of stalling the run", async () => {
    expect(FETCH_TIMEOUT_MS).toBe(10_000);
    const sockets: Socket[] = [];
    const silent = createServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const port = (silent.address() as AddressInfo).port;
    const started = Date.now();
    const target = new URL("http://127.0.0.1:1/quote");
    target.port = String(port);
    await expect(nodeRuntime(Date.now, process, 200).fetch(target.href)).rejects.toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - started).toBeLessThan(5_000);
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => silent.close(resolve));
  });

  it("reads wall-clock seconds and builds an rpc transport", async () => {
    const rt = nodeRuntime(() => 1_700_000_000_999);
    expect(rt.now()).toBe(1_700_000_000n);
    expect(rt.loadSigner).toBe(loadKeypairFile);
    expect(Object.keys(rt.transport("http://127.0.0.1:1"))).toEqual([
      "getAccount",
      "getAccounts",
      "send",
      "airdrop",
      "latestBlockhash",
      "sendWire",
      "submitWire",
      "simulate",
      "genesisHash",
      "recentFees",
      "budget",
      "engineTransactions",
      "signaturesOf",
      "transactionsOf",
      "transactionOf",
      "signatureStatuses",
      "sendStatus",
      "firstAvailableSlot",
      "finalizedBlock",
      "engineAccounts",
      "intents",
    ]);
    expect(Number.isInteger(rt.entropy())).toBe(true);
    expect(typeof rt.fetch).toBe("function");
    const live = nodeRuntime().now();
    expect(Number(live)).toBeCloseTo(Date.now() / 1000, -1);
    expect(rt.env).toBe(process.env);
    expect(await rt.sleep(0)).toBe(true);
    const dir = await mkdtemp(join(tmpdir(), "engine-cli-"));
    const path = join(dir, "signed.json");
    await rt.writeText(path, "first");
    expect(await rt.readText(path)).toBe("first");
    await expect(rt.writeText(path, "second")).rejects.toMatchObject({ code: "EEXIST" });
    expect(await rt.readText(path)).toBe("first");
  });

  it("runs a process, dropping node and script from argv", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const proc = {
      argv: ["node", "bin.js", "pda", "--owner", "11111111111111111111111111111112", "--nonce", "1"],
      stdout: { write: (t: string) => out.push(t) },
      stderr: { write: (t: string) => err.push(t) },
    };
    expect(await runProcess(proc, runtime({}))).toBe(EXIT_OK);
    expect(out).toHaveLength(1);
    expect(out[0]?.endsWith("}\n")).toBe(true);
    const bad = { ...proc, argv: ["node", "bin.js", "fly"] };
    expect(await runProcess(bad, runtime({}))).toBe(EXIT_USAGE);
    expect(err.at(-1)?.startsWith("usage:")).toBe(true);
    expect(err.at(-1)?.endsWith("\n")).toBe(true);
  });

  it("does not need the network to build commands", async () => {
    const owner = "11111111111111111111111111111112" as Address;
    const [intent] = await findIntentPda({ owner, nonce: 0n });
    const [vault] = await findVaultPda({ intent });
    h.urls.length = 0;
    await expect(run({ name: "pda", owner, nonce: 0n }, runtime({}))).resolves.toEqual({ intent, vault });
    expect(h.urls).toEqual([]);
  });
});

describe("event monitoring", () => {
  it("decodes engine events per transaction and counts the notable ones", async () => {
    const key = "11111111111111111111111111111112" as Address;
    const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
    h.engineLog = [
      {
        signature: testSignature("sig-a"),
        slot: 9n,
        blockTime: 1_700_000_000n,
        failed: false,
        emitted: [
          tag(getPauseRaisedEventEncoder().encode({ by: key, paused: 2 })),
          new Uint8Array([1, 2, 3]),
          tag(getUserInitializedEventEncoder().encode({ owner: key })),
        ],
      },
      {
        signature: testSignature("sig-b"),
        slot: 10n,
        blockTime: null,
        failed: true,
        emitted: [tag(getPauseRaisedEventEncoder().encode({ by: key, paused: 0 }))],
      },
      {
        signature: testSignature("sig-c"),
        slot: 11n,
        blockTime: null,
        failed: false,
        emitted: [tag(getPauseRaisedEventEncoder().encode({ by: key, paused: 2 }).subarray(0, 12))],
      },
    ];
    h.requestedLimits.length = 0;
    const result = await cli(["events", "--limit", "7"], {});
    expect(h.requestedLimits).toEqual([7]);
    expect(result.json()).toEqual({
      notable: 1,
      transactions: [
        {
          signature: testSignature("sig-a"),
          slot: "9",
          blockTime: "1700000000",
          failed: false,
          events: [
            { name: "PauseRaised", notable: true, fields: { by: key, paused: 2 } },
            { name: "UserInitialized", notable: false, fields: { owner: key } },
          ],
        },
        { signature: testSignature("sig-b"), slot: "10", blockTime: null, failed: true, events: [] },
        { signature: testSignature("sig-c"), slot: "11", blockTime: null, failed: false, events: [] },
      ],
    });
    h.requestedLimits.length = 0;
    await cli(["events"], {});
    expect(h.requestedLimits).toEqual([20]);
    h.engineLog = [];
  });
});
