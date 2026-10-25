import type { Address } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { findIntentPda, findVaultPda } from "@intent-engine/core/internal";
import { CONFIRM_URL_OR_NOT, parse } from "../src/args.js";
import { sameNode } from "../src/arg-values.js";
import { clusterUrl, SAVED_CONFIRM_URL } from "../src/clusters.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, readsOneNode } from "../src/main.js";
import { confirmElsewhere, confirmUnreachable, settingsPath, withSettings } from "../src/wallet.js";
import { ata, balance, cli, ESCROW, h, HOME, mint, NOW, runtime, type World, world, funded } from "./harness.js";
import { cliWith, type Lie, OTHER_GENESIS, SECOND, SECOND_URL, secondNode } from "./confirm-node.js";

type Solved = { filled: { intent: Address }[]; sent: unknown[]; skipped: { intent: Address; reason: string }[]; failed: unknown[] };

describe("solve --confirm-url", () => {
  let w: World;

  beforeEach(async () => {
    w = await world();
    h.watched.push(w.owner.address);
  });

  async function order() {
    const solver = await funded();
    const issued = await mint(solver, 6);
    const created = await cli(
      [
        "create", "swap", "--keypair", "owner.json", "--nonce", "8", "--input-mint", w.inputMint, "--output-mint", issued,
        "--expires-at", (NOW + 3_600n).toString(), "--amount-in", ESCROW.toString(), "--min-out", "300", "--units", "raw", "--url", "http://cluster", "--yes",
      ],
      { "owner.json": w.owner },
    );
    expect(created.code).toBe(EXIT_OK);
    const receiver = await ata(w.authority, w.owner.address, issued);
    await ata(w.authority, w.feeRecipient.address, w.inputMint);
    const solverInput = await ata(w.authority, solver.address, w.inputMint);
    const solverOutput = await ata(w.authority, solver.address, issued);
    const [intent] = await findIntentPda({ owner: w.owner.address, nonce: 8n });
    const solve = ["solve", "--keypair", "s.json", "--issue", `${w.inputMint}:${issued}=1/1`, "--min-profit", `${issued}=1`, "--url", "http://cluster", "--confirm-url", SECOND];
    return { solver, intent, receiver, solverInput, solverOutput, solve };
  }

  it("skips the fill, saying why, when the second node reports another balance, intent or genesis hash, or cannot be read", async () => {
    const { solver, intent, receiver, solverInput, solverOutput, solve } = await order();
    const [vault] = await findVaultPda({ intent });
    const node = secondNode();
    const cases: [Lie, string][] = [
      [{ balance: solverInput }, `the two RPC nodes report a different account: the first ${solverInput} sha256 `],
      [{ balance: solverOutput }, `the two RPC nodes report a different account: the first ${solverOutput} sha256 `],
      [{ balance: vault }, `the two RPC nodes report a different account: the first ${vault} sha256 `],
      [{ intent }, "the two RPC nodes report a different intent account"],
      [{ genesis: OTHER_GENESIS }, `the two RPC nodes report a different genesis hash: the first ${h.genesis}, the second ${OTHER_GENESIS}`],
      [{ down: true }, "the second RPC node could not be read (unreadable: fetch failed), so the fill was not sent"],
    ];
    for (const [lie, reason] of cases) {
      node.lie = lie;
      h.wires.length = 0;
      const run = await cliWith(solve, { "s.json": solver }, node);
      expect(run.code).toBe(EXIT_OK);
      const report = run.json() as Solved;
      expect(report.skipped.map((s) => s.intent)).toEqual([intent]);
      expect(report.skipped[0]?.reason).toContain(reason);
      expect([report.filled, report.sent, report.failed, h.wires]).toEqual([[], [], [], []]);
      expect(balance(receiver)).toBe(0n);
    }
  });

  it("sends the fill when both nodes agree", async () => {
    const { solver, intent, receiver, solve } = await order();
    const node = secondNode();
    const run = await cliWith(solve, { "s.json": solver }, node);
    expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
    expect((run.json() as Solved).filled.map((f) => f.intent)).toEqual([intent]);
    expect(run.urls).toContain(SECOND_URL);
    expect(node.reads).toBeGreaterThan(0);
    expect(balance(receiver)).toBe(300n);
  });

  it("reads one node without the flag", async () => {
    const { solver, intent, solve } = await order();
    const node = secondNode();
    node.lie = { down: true };
    const run = await cliWith(solve.slice(0, -2), { "s.json": solver }, node);
    expect((run.json() as Solved).filled.map((f) => f.intent)).toEqual([intent]);
    expect(node.reads).toBe(0);
  });
});

describe("the confirm-url setting", () => {
  beforeEach(async () => {
    await world();
  });

  const SETTINGS = settingsPath(HOME);

  it("is saved by setup --confirm-url, kept by a later setup, and replaced by a new one", async () => {
    const first = await cli(["setup", "--confirm-url", SECOND], {});
    expect(first.code).toBe(EXIT_OK);
    expect(first.json()).toMatchObject({ confirm_url: SECOND_URL });
    expect(JSON.parse(h.files.get(SETTINGS) ?? "{}")).toMatchObject({ [SAVED_CONFIRM_URL]: SECOND_URL });
    expect((await cli(["setup"], {})).json()).toMatchObject({ confirm_url: SECOND_URL });
    expect(JSON.parse(h.files.get(SETTINGS) ?? "{}")).toMatchObject({ [SAVED_CONFIRM_URL]: SECOND_URL });
    await cli(["setup", "--confirm-url", "localnet"], {});
    expect(JSON.parse(h.files.get(SETTINGS) ?? "{}")).toMatchObject({ [SAVED_CONFIRM_URL]: clusterUrl("localnet") });
  });

  it("is saved by setup only when the url answers on the same cluster", async () => {
    const node = secondNode();
    node.lie = { down: true };
    const down = await cliWith(["setup", "--confirm-url", SECOND], {}, node);
    expect([down.code, down.err]).toEqual([EXIT_FAILED, confirmUnreachable(SECOND_URL, "fetch failed")]);
    expect(h.files.has(SETTINGS)).toBe(false);
    node.lie = { genesis: OTHER_GENESIS };
    const elsewhere = await cliWith(["setup", "--confirm-url", SECOND], {}, node);
    expect([elsewhere.code, elsewhere.err]).toEqual([EXIT_FAILED, confirmElsewhere(SECOND_URL, h.genesis, OTHER_GENESIS)]);
    expect(h.files.has(SETTINGS)).toBe(false);
    node.lie = {};
    const saved = await cliWith(["setup", "--confirm-url", SECOND], {}, node);
    expect([saved.code, saved.err]).toEqual([EXIT_OK, ""]);
    expect(JSON.parse(h.files.get(SETTINGS) ?? "{}")).toMatchObject({ [SAVED_CONFIRM_URL]: SECOND_URL });
    const same = await cli(["setup", "--url", "devnet", "--confirm-url", "https://API.devnet.solana.com/"], {});
    expect([same.code, same.err]).toEqual([EXIT_USAGE, sameNode("https://API.devnet.solana.com/")]);
  });

  it("applies the saved confirm-url only to commands that take it, skips it for one run with --no-confirm-url, and refuses the first node as the second", () => {
    const env = { [SAVED_CONFIRM_URL]: SECOND_URL };
    const owner = "11111111111111111111111111111112";
    const judge = ["judge", "--keypair", "k", "--owner", owner, "--nonce", "0", "--spec", "s", "--artifact", "a", "--sandbox", "viper"];
    const digest = parse(["judge", "digest", "--owner", owner, "--nonce", "0", "--announcement", owner, "--sha256", "ab".repeat(32), "--salt", "cd".repeat(16)], env);
    expect(digest).toMatchObject({ name: "judge-digest" });
    expect(digest).not.toHaveProperty("confirmUrl");
    for (const argv of [judge, ["committee", "release", "--keypair", "k", "--vote", "v"], ["mcp", "--wallet"]]) {
      expect(parse(argv, env), argv[0]).toMatchObject({ confirmUrl: SECOND_URL });
      expect(parse([...argv, "--no-confirm-url"], env), argv[0]).not.toHaveProperty("confirmUrl");
      expect(readsOneNode(parse([...argv, "--no-confirm-url"], env)), argv[0]).toBe(true);
      expect(() => parse([...argv, "--no-confirm-url", "--confirm-url", SECOND], env), argv[0]).toThrow(CONFIRM_URL_OR_NOT);
      expect(() => parse([...argv, "--url", SECOND], env), argv[0]).toThrow(sameNode(SECOND_URL));
      expect(parse([...argv, "--url", SECOND, "--no-confirm-url"], env), argv[0]).not.toHaveProperty("confirmUrl");
    }
    expect(() => parse([...judge, "--url", "devnet", "--confirm-url", `${clusterUrl("devnet")}/`])).toThrow(sameNode(`${clusterUrl("devnet")}/`));
    const local = "http://" + "127.0.0.1:8899";
    for (const confirm of ["http://" + "localhost:8899/", "http://" + "[::1]:8899", "HTTP://" + "LOCALHOST.:8899"]) {
      expect(() => parse([...judge, "--url", local, "--confirm-url", confirm]), confirm).toThrow(sameNode(confirm));
    }
    expect(parse([...judge, "--url", local, "--confirm-url", "http://" + "localhost:8900"])).toMatchObject({ confirmUrl: "http://" + "localhost:8900" });
    const keyed = "https://" + "rpc.example.org/?b=2&a=1";
    expect(() => parse([...judge, "--url", "https://" + "rpc.example.org./?a=1&b=2", "--confirm-url", keyed])).toThrow(sameNode(keyed));
    expect(parse([...judge, "--url", "https://" + "rpc.example.org/?a=1", "--confirm-url", keyed])).toMatchObject({ confirmUrl: keyed });
    expect(() => parse(["judge", "digest", "--owner", owner, "--nonce", "0", "--announcement", owner, "--sha256", "ab".repeat(32), "--salt", "cd".repeat(16), "--no-confirm-url"])).toThrow("judge digest does not take --no-confirm-url");
  });

  it("is left out when never set, and a settings file with a non-text confirm-url is refused", async () => {
    const made = await cli(["setup"], {});
    expect(made.json()).not.toHaveProperty("confirm_url");
    expect(JSON.parse(h.files.get(SETTINGS) ?? "{}")).not.toHaveProperty(SAVED_CONFIRM_URL);
    h.files.set(SETTINGS, JSON.stringify({ url: "devnet", keypair: "k", [SAVED_CONFIRM_URL]: 7 }));
    await expect(withSettings(runtime({}), {})).rejects.toThrow("is not a settings file this CLI wrote");
  });

  it("fills in --confirm-url for judge, committee release and mcp only, and never comes from the environment", async () => {
    const env = { [SAVED_CONFIRM_URL]: SECOND_URL };
    const owner = (await funded()).address;
    const judge = ["judge", "--keypair", "k", "--owner", owner, "--nonce", "0", "--spec", "s", "--artifact", "a", "--sandbox", "viper"];
    expect(parse(judge, env)).toMatchObject({ confirmUrl: SECOND_URL });
    expect(parse([...judge, "--confirm-url", "devnet"], env)).toMatchObject({ confirmUrl: clusterUrl("devnet") });
    expect(parse(["committee", "release", "--keypair", "k", "--vote", "v"], env)).toMatchObject({ confirmUrl: SECOND_URL });
    expect(parse(["mcp", "--wallet", "--url", "devnet"], env)).toMatchObject({ confirmUrl: SECOND_URL });
    expect(parse(["solve", "--keypair", "k", "--issue", `${owner}:${owner}=1/1`, "--min-profit", `${owner}=1`], env)).not.toHaveProperty("confirmUrl");
    expect(await withSettings(runtime({}), { [SAVED_CONFIRM_URL]: SECOND_URL })).toMatchObject({ [SAVED_CONFIRM_URL]: undefined });
  });

  it("decides the one-node notice by whether a second node is set", () => {
    const owner = "11111111111111111111111111111112";
    const judge = ["judge", "--keypair", "k", "--owner", owner, "--nonce", "0", "--spec", "s", "--artifact", "a", "--sandbox", "viper"];
    expect(readsOneNode(parse(judge, {}))).toBe(true);
    expect(readsOneNode(parse([...judge.slice(0, -4), "--watch", "--sandbox", "viper"], {}))).toBe(true);
    expect(readsOneNode(parse(judge, { [SAVED_CONFIRM_URL]: SECOND_URL }))).toBe(false);
    expect(readsOneNode(parse([...judge, "--confirm-url", SECOND], {}))).toBe(false);
    expect(readsOneNode(parse(["committee", "release", "--keypair", "k", "--vote", "v"], {}))).toBe(true);
    expect(readsOneNode(parse(["mcp", "--wallet", "--url", "devnet"], {}))).toBe(true);
    expect(readsOneNode(parse(["mcp", "--url", "devnet"], {}))).toBe(false);
    expect(readsOneNode(parse(["balance", "--owner", owner], {}))).toBe(false);
  });
});
