import { type Address, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { testSignature } from "@intent-engine/client/testing";
import { findIntentPda, EVENT_IX_TAG, getPauseRaisedEventEncoder } from "@intent-engine/core/internal";
import { type Transport } from "@intent-engine/client";
import { follow, followGap, type Runtime } from "../src/commands.js";
import { execute, FlowRefused } from "../src/flows.js";
import { renderText } from "../src/render.js";
import { CLUSTERS, ENV_KEYPAIR, ENV_URL } from "../src/args.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, main, unreachable } from "../src/main.js";
import { cli, h, runtime, transport, type World } from "./harness.js";
import { flowCreate, flowWorld } from "./flows-kit.js";

describe("command line flows", () => {
  let w: World;
  let keys: Record<string, KeyPairSigner>;

  beforeEach(async () => {
    ({ w, keys } = await flowWorld());
  });

  const create = (kind: string, ...rest: string[]) => flowCreate(w, kind, ...rest);

  it("prints help once and names the node and the fix when it cannot be reached", async () => {
    const help = (await cli(["help"], {})).out;
    expect(help.startsWith("usage: setup | add-to claude|codex | balance | new-wallet | send-sol | pda | domain | mcp")).toBe(true);
    expect(help).not.toContain("usage: usage:");
    const err: string[] = [];
    const down = {
      ...runtime({}),
      transport: () => ({
        ...transport,
        getAccount: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    };
    const code = await main(["show", "config"], down, { out: () => undefined, err: (t) => err.push(t) });
    expect([code, err]).toEqual([EXIT_FAILED, [unreachable("http://127.0.0.1:8899")]]);
    expect(unreachable("x")).toBe(
      "cannot reach the RPC node at x; check your network connection and that this endpoint is up, or pass another --url or set INTENT_ENGINE_URL",
    );
    const other: string[] = [];
    const broken = { ...down, transport: () => ({ ...transport, getAccount: async () => { throw new TypeError("other"); } }) };
    await main(["show", "config"], broken, { out: () => undefined, err: (t) => other.push(t) });
    expect(other).toEqual(["other"]);
    const plain: string[] = [];
    const failing = { ...down, transport: () => ({ ...transport, getAccount: async () => { throw new Error("fetch failed"); } }) };
    await main(["show", "config"], failing, { out: () => undefined, err: (t) => plain.push(t) });
    expect(plain).toEqual(["fetch failed"]);
    const noUrl: string[] = [];
    await main(["pda", "--owner", w.owner.address, "--nonce", "x"], down, { out: () => undefined, err: (t) => noUrl.push(t) });
    expect(noUrl[0]).not.toContain("cannot reach");
  });

  it("the unreachable message names the url it tried", async () => {
    const down = {
      ...runtime({}),
      transport: () => ({
        ...transport,
        getAccount: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    };
    const tried = async (...url: string[]) => {
      const err: string[] = [];
      const code = await main(["show", "config", ...url], down, { out: () => undefined, err: (t) => err.push(t) });
      expect(code).toBe(EXIT_FAILED);
      return err;
    };
    const devnet = await tried("--url", "devnet");
    expect(devnet).toEqual([unreachable("https://api.devnet.solana.com")]);
    expect(devnet[0]).toContain("at https://api.devnet.solana.com;");
    expect(devnet[0]).not.toContain("mainnet-beta");
    expect(devnet[0]).not.toContain("--url devnet");
    const secret = await tried("--url", "https://user:token@rpc.example.org:8443/key/abc?api-key=xyz");
    expect(secret).toEqual([unreachable("https://rpc.example.org:8443")]);
    expect(secret[0]).not.toMatch(/token|abc|xyz/);
  });

  it("answers help, prints text on request and honours the environment and cluster names", async () => {
    const help = await cli(["help", "cancel"], {});
    expect(help.out).toBe(
      "usage: cancel [--keypair <file>] --nonce <n> [--close] [--yes]\noptions: --url, --priority-fee, --keypair, --yes, --nonce, --close, --output, --help, --debug",
    );
    expect((await cli(["approve", "--help"], {})).out.startsWith("usage: approve [--keypair <file>]")).toBe(true);
    const text = await cli(["show", "config", "--output", "text"], {});
    expect(text.out.split("\n")).toContain(`feeRecipient: ${w.feeRecipient.address}`);
    const preview = await cli([...create("swap", "--amount-in", "400", "--min-out", "300"), "--output", "text"], keys);
    const lines = preview.out.split("\n");
    expect(lines[0]).toBe(`Sell: exactly 0.0004 of ${w.inputMint}`);
    expect(lines).toContain("sent: false");
    expect(lines.some((l) => l.startsWith("warnings:"))).toBe(false);
    expect(lines).toContain("next: nothing was sent; check the summary and pass --yes to sign and send");
    expect(renderText({ summary: ["Sell: 1"], warnings: ["long", "scaled"], sent: false }).split("\n")).toEqual([
      "Sell: 1",
      "WARNING: long",
      "WARNING: scaled",
      "sent: false",
    ]);
    expect(renderText({ summary: ["Sell: 1", "WARNING: long"], warnings: ["long"] }).split("\n")).toEqual([
      "Sell: 1",
      "WARNING: long",
    ]);
    expect(renderText({ warnings: ["long"], gap: true }).split("\n")).toEqual(["WARNING: long", "gap: true"]);
    expect(renderText({ warnings: "none" })).toBe("warnings: none");
    expect((await cli(["show", "config", "--output", "yaml"], {})).code).toBe(EXIT_USAGE);
    await cli([...create("swap", "--amount-in", "400", "--min-out", "300"), "--yes"], keys);
    h.env[ENV_KEYPAIR] = "owner.json";
    h.env[ENV_URL] = "devnet";
    h.urls.length = 0;
    expect((await cli(["cancel", "--nonce", "0", "--yes"], keys)).code).toBe(EXIT_OK);
    expect(h.urls).toEqual([CLUSTERS["devnet"]]);
    const [intent] = await findIntentPda({ owner: w.owner.address, nonce: 0n });
    expect((await cli(["show", "intent", "--owner", w.owner.address, "--nonce", "0", "--url", "localnet"], {})).json()).toMatchObject({
      address: intent,
      status: "cancelled",
    });
    expect(h.urls.at(-1)).toBe(CLUSTERS["localnet"]);
  });

  it("events follow survives a failed poll", async () => {
    const tx = (label: string) => ({ signature: testSignature(label), slot: 1n, blockTime: null, failed: false, emitted: [] });
    const polls: (Error | ReturnType<typeof tx>[])[] = [
      [tx("a")],
      new TypeError("fetch failed"),
      new Error("HTTP error (503): Service Unavailable"),
      [tx("b"), tx("a")],
      new Error("HTTP error (502): Bad Gateway"),
      [tx("c"), tx("b")],
    ];
    h.through = {
      ...transport,
      engineTransactions: async () => {
        const next = polls.shift() ?? [];
        if (next instanceof Error) {
          throw next;
        }
        return next;
      },
    };
    h.sleeps.length = 0;
    h.rounds = 6;
    const followed = await cli(["events", "--follow", "--interval", "4"], {});
    h.through = null;
    h.rounds = 0;
    expect([followed.code, followed.err]).toEqual([EXIT_OK, ""]);
    const shown = followed.each().map((v) => v["signature"] ?? v["error"]);
    expect(shown).toEqual([testSignature("a"), "fetch failed", "HTTP error (503): Service Unavailable", testSignature("b"), "HTTP error (502): Bad Gateway", testSignature("c")]);
    expect(followed.each().filter((v) => "error" in v).map((v) => v["retry_in"])).toEqual([1, 2, 1]);
    expect(h.sleeps).toEqual([4, 1, 2, 4, 1, 4]);
  });

  it("follows new engine events without repeating them until told to stop", async () => {
    const key = "11111111111111111111111111111112" as Address;
    const tag = new Uint8Array([...EVENT_IX_TAG, ...getPauseRaisedEventEncoder().encode({ by: key, paused: 2 })]);
    h.engineLog = [
      { signature: testSignature("new"), slot: 2n, blockTime: null, failed: false, emitted: [tag] },
      { signature: testSignature("old"), slot: 1n, blockTime: null, failed: false, emitted: [] },
    ];
    h.sleeps.length = 0;
    h.rounds = 3;
    const followed = await cli(["events", "--follow", "--interval", "4", "--limit", "5"], {});
    expect(followed.code).toBe(EXIT_OK);
    const shown = followed.out.split("\n}\n").length;
    expect(shown).toBe(2);
    expect(followed.out.indexOf(`"${testSignature("old")}"`)).toBeLessThan(followed.out.indexOf(`"${testSignature("new")}"`));
    expect(h.sleeps).toEqual([4, 4, 4]);
    h.sleeps.length = 0;
    h.rounds = 1;
    const quiet = await cli(["events", "--follow", "--output", "text"], {});
    expect(quiet.out.split("\n").filter((l) => l.startsWith("signature: "))).toEqual([`signature: ${testSignature("old")}`, `signature: ${testSignature("new")}`]);
    expect(h.sleeps).toEqual([10]);
    h.engineLog = [];
    h.rounds = 0;
  });
});

describe("sending a prepared transaction", () => {
  it("refuses one that needs any signature besides the caller's", async () => {
    const signer = await generateKeyPairSigner();
    const other = await generateKeyPairSigner();
    const view = { transaction: "", signers: [signer.address, other.address], last_valid_block_height: 1n };
    await expect(execute({} as Transport, view, signer)).rejects.toThrow(
      new FlowRefused(`this transaction also needs signatures from ${other.address}`),
    );
  });
});

describe("following events", () => {
  it("says when more transactions landed between polls than one poll fetches", async () => {
    const tx = (label: string) => ({ signature: testSignature(label), slot: 1n, blockTime: null, failed: false, emitted: [] });
    const polls = [[tx("b"), tx("a")], [tx("d"), tx("c")], [tx("e"), tx("d")]];
    const transport = { engineTransactions: async () => polls.shift() ?? [] } as unknown as Transport;
    const runtime = { sleep: async () => polls.length > 0 } as unknown as Runtime;
    const emitted: object[] = [];
    expect(await follow(transport, runtime, 2, 1, (v) => emitted.push(v))).toBe(5);
    expect(emitted.map((v) => ("signature" in v ? v.signature : v))).toEqual([
      testSignature("a"),
      testSignature("b"),
      { gap: true, warning: followGap(2) },
      testSignature("c"),
      testSignature("d"),
      testSignature("e"),
    ]);
    expect(followGap(2)).toBe(
      "more than 2 engine transactions landed since the last poll, so some were not shown; raise --limit or lower --interval",
    );
  });
});
