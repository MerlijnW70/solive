import { type Address, lamports } from "@solana/kit";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_EXPIRES_IN as CLIENT_MAX, MIN_EXPIRES_IN as CLIENT_MIN, TOKEN_PROGRAMS as CLIENT_PROGRAMS } from "@intent-engine/client/internal";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { MAX_MICRO_LAMPORTS, U64_MAX } from "@intent-engine/core/internal";
import { CLUSTERS, parse, UsageError } from "../src/args.js";
import { MAX_EXPIRES_IN, MIN_EXPIRES_IN } from "../src/agent/create.js";
import { JOB_PROMPTS, proseFor, START_PROMPT } from "../src/agent/mcp.js";
import { walletEmpty } from "../src/agent/wallet.js";
import { workerBrief } from "../src/agent/wallet/worker-brief.js";
import { MAX_FOLLOW_INTERVAL } from "../src/arg-solve.js";
import { DEVNET_URL } from "../src/tokens.js";
import { newWalletNext } from "../src/wallet-commands.js";
import { airdropRefused, appWay, APP_WAY, CLI_START, ENOUGH_TO_START, faucetLink, heldRefused, LAMPORTS_PER_SOL, otherWays, pasteFirst, publicFaucetFor, startOn, SWAP_START, unfundedPreview, unfundedRefused } from "../src/wallet.js";
import { airdropped } from "./airdrop.js";
import { call, connect, ok } from "./agent-wallet-kit.js";
import { cli, h, world } from "./harness.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const CUSTOM = "https://" + "rpc.example.org";
const OFF_DEVNET: readonly [string, string][] = [
  ["localnet", CLUSTERS["localnet"] ?? ""],
  ["testnet", CLUSTERS["testnet"] ?? ""],
  [CUSTOM, CUSTOM],
];
const NAMED = /devnet/i;
const DEVNET_ONLY = /\bTEST\b|(?:demo|raw\.githubusercontent|faucet\.yml)/

describe("no text names devnet on another cluster", () => {
  beforeEach(async () => {
    await world();
  });

  it.each(OFF_DEVNET)("setup on %s names no devnet in any field and offers no devnet route", async (flag, url) => {
    h.airdropRefused = true;
    const made = (await cli(["setup", "--url", flag], {})).json();
    const address = made["address"] as Address;
    expect(JSON.stringify(made)).not.toMatch(NAMED);
    expect(made["other_ways"]).toEqual(otherWays(address, "", url));
    expect(made["other_ways"]).toEqual(publicFaucetFor(url) ? [appWay(address, url), pasteFirst(address)] : [appWay(address, url)]);
    expect(JSON.stringify(made["other_ways"])).not.toContain(faucetLink(address));
    expect(JSON.stringify(made["other_ways"])).not.toContain("faucet.yml");
  });

  it.each(OFF_DEVNET)("setup and the wallet server on %s offer no devnet-only resource", async (flag, url) => {
    const texts: string[] = [];
    const client = await connect(["mcp", "--url", flag, "--wallet", "--all-tools"]);
    texts.push(client.getInstructions() ?? "");
    for (const { name } of (await client.listPrompts()).prompts) {
      texts.push(JSON.stringify((await client.getPrompt({ name })).messages));
    }
    h.airdropRefused = true;
    const made = await ok(client, "wallet_setup");
    const address = made["address"] as Address;
    texts.push(JSON.stringify(made));
    for (const held of [LAMPORTS_PER_SOL / 50n, ENOUGH_TO_START - LAMPORTS_PER_SOL / 50n, SWAP_START, LAMPORTS_PER_SOL]) {
      airdropped(h.svm, address, lamports(held));
      texts.push(JSON.stringify(await ok(client, "wallet_setup")));
    }
    const empty = (await cli(["setup", "--url", flag], {})).json();
    texts.push(JSON.stringify(empty), airdropRefused(address, url), heldRefused("0.02", address, url), startOn(CLI_START, url));
    for (const text of texts) {
      expect(text).not.toMatch(DEVNET_ONLY);
      expect(text).not.toMatch(/demo/i);
      if (!publicFaucetFor(url)) {
        expect(text).not.toContain("faucet.solana.com");
      }
    }
    expect(texts[0]).toContain("Name tokens SOL or by mint");
    expect(proseFor([], url).join(" ")).toContain("Name tokens SOL or by mint; amounts are whole tokens");
    expect(proseFor([], url).join(" ")).not.toMatch(DEVNET_ONLY);
    expect(texts.join(" ")).toContain("a token you name by its mint address");
  });

  it.each(OFF_DEVNET)("every tool description and schema field on %s names no TEST, demo or devnet", async (flag) => {
    for (const argv of [["--wallet", "--all-tools"], []]) {
      const client = await connect(["mcp", "--url", flag, ...argv]);
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(10);
      const strings = tools.flatMap((tool) => stringsOf(tool));
      expect(strings.length).toBeGreaterThan(100);
      for (const text of strings) {
        expect(text).not.toMatch(NAMED);
        expect(text).not.toMatch(DEVNET_ONLY);
        expect(text).not.toMatch(/demo/i);
      }
    }
  });

  it("keeps the TEST token in the tool descriptions on devnet", async () => {
    const client = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    const strings = (await client.listTools()).tools.flatMap((tool) => stringsOf(tool));
    expect(strings.filter((text) => /\bTEST\b/.test(text)).length).toBeGreaterThan(8);
    expect(strings).toContain("SOL, TEST or a mint address");
    expect(strings.some((text) => text.includes("on devnet, the TEST token"))).toBe(true);
  });

  it.each(OFF_DEVNET)("an unnamed token refusal on %s offers no TEST", async (flag) => {
    const client = await connect(["mcp", "--url", flag, "--wallet", "--all-tools"]);
    await ok(client, "wallet_setup");
    const swap = (await call(client, "wallet_swap", { sell: "SOL", buy: "not-a-mint", amount: "0.05", min_receive: "5" })).value;
    const jobs = (await call(client, "find_jobs", { mint: "not-a-mint" })).value;
    for (const refused of [swap, jobs]) {
      expect(JSON.stringify(refused)).toContain("name SOL or a token mint address");
      expect(JSON.stringify(refused)).not.toMatch(DEVNET_ONLY);
      expect(JSON.stringify(refused)).not.toMatch(NAMED);
    }
  });

  it("keeps the devnet resources on devnet", async () => {
    const client = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    const text = client.getInstructions() ?? "";
    expect(text).toContain("Name tokens SOL, TEST or by mint");
    expect(text).toContain("a demo worker delivers it within a minute");
    expect(text).toContain("raw.githubusercontent.com");
    expect(JSON.stringify((await client.getPrompt({ name: "start" })).messages)).toContain("5 TEST");
    expect(startOn(CLI_START, DEVNET_URL)).toBe(CLI_START);
    expect(heldRefused("0.02", "A".repeat(44), DEVNET_URL)).toContain("faucet.solana.com");
  });

  it("keeps the devnet routes on devnet", async () => {
    const address = "A".repeat(44);
    expect(otherWays(address, "", DEVNET_URL)[0]).toBe(APP_WAY(address));
    expect(appWay(address, DEVNET_URL)).toBe(APP_WAY(address));
    expect(otherWays(address, "", DEVNET_URL)[2]).toContain(faucetLink(address));
  });

  it.each(OFF_DEVNET)("the funding refusals on %s name no devnet", (_, url) => {
    const address = "A".repeat(44);
    for (const text of [unfundedPreview(address, url), unfundedRefused(address, url), walletEmpty(address, url), ...otherWays(address, "", url)]) {
      expect(text).not.toMatch(NAMED);
    }
    expect(walletEmpty(address, url)).not.toContain(faucetLink(address));
  });

  it("an empty wallet server on localnet refuses a swap without naming devnet or the devnet faucet", async () => {
    h.airdropRefused = true;
    const client = await connect(["mcp", "--url", "localnet", "--wallet", "--all-tools"]);
    const made = await ok(client, "wallet_setup");
    const address = made["address"] as Address;
    expect(JSON.stringify(made)).not.toMatch(NAMED);
    const refused = (await call(client, "wallet_swap", { sell: "SOL", buy: DEVNET_TEST_MINT, amount: "0.05", min_receive: "5" })).value;
    expect(refused).toMatchObject({ code: "WalletEmpty", hint: walletEmpty(address, CLUSTERS["localnet"] ?? "") });
    expect(JSON.stringify(refused)).not.toMatch(NAMED);
  });

  it("a wallet server's instructions, prompts and setup description name no devnet", async () => {
    const client = await connect(["mcp", "--url", "localnet", "--wallet", "--all-tools"]);
    expect(client.getInstructions()).not.toMatch(NAMED);
    expect((await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"])).getInstructions()).toContain("This wallet lives on devnet, Solana's free test network.");
    expect(START_PROMPT).not.toMatch(NAMED);
    for (const prompt of JOB_PROMPTS) {
      expect(prompt.text, prompt.name).not.toMatch(NAMED);
    }
    const listed = (await client.listPrompts()).prompts;
    for (const prompt of listed) {
      expect(`${prompt.title} ${prompt.description}`, prompt.name).not.toMatch(NAMED);
    }
    const tools = (await client.listTools()).tools;
    const setup = tools.find((tool) => tool.name.endsWith("wallet_setup"));
    const fields = (setup?.outputSchema as { properties: Record<string, { description?: string; properties?: Record<string, { description?: string }> }> }).properties;
    expect(setup?.description).not.toMatch(NAMED);
    for (const name of ["airdrop", "why"]) {
      expect(fields[name]?.description, name).not.toMatch(NAMED);
    }
    expect(fields["faucet"]?.properties?.["lamports"]?.description).not.toMatch(NAMED);
  });

  it("the local worker brief and the new wallet note name no devnet off devnet", () => {
    const brief = workerBrief({ intent: "A".repeat(44) as Address, owner: "B".repeat(44) as Address, nonce: 0n, specUrl: "https://" + "a.example/spec", specHash: "0".repeat(64), keypair: "k.json", rpc: CLUSTERS["localnet"] ?? "", claim: undefined });
    expect(brief).not.toMatch(NAMED);
    expect(newWalletNext("worker.json")).not.toMatch(NAMED);
  });

  it("the one-node note names no cluster, since mainnet needs more than one node", async () => {
    const { ONE_NODE } = await import("../src/main.js");
    expect(ONE_NODE).not.toMatch(NAMED);
  });
});

describe("each bound has one source", () => {
  it("the CLI expiry bounds are the SDK's", () => {
    expect([BigInt(MIN_EXPIRES_IN), BigInt(MAX_EXPIRES_IN)]).toEqual([CLIENT_MIN, CLIENT_MAX]);
  });

  it("the relay ttl limits are the expiry limits", () => {
    const free = ["--relayer", "R", "--relay-fee", "SOL=0", "--relay-max-lamports", "1"];
    const relay = (ttl: number) => () => parse(["mcp", "--wallet", ...free, "--relay-max-ttl", String(ttl)], {});
    expect(relay(MAX_EXPIRES_IN)).not.toThrow(/ttl/);
    expect(relay(MAX_EXPIRES_IN + 1)).toThrow(new UsageError(`--relay-max-ttl must be an integer from 0 to ${MAX_EXPIRES_IN}`));
    expect(relay(MIN_EXPIRES_IN - 1)).toThrow(`--relay-max-ttl must be at least ${MIN_EXPIRES_IN} and --relay-per-hour at least 1`);
  });

  it("every watch interval shares one bound", () => {
    const usage = (argv: string[]) => {
      try {
        parse(argv, {});
      } catch (error) {
        return error instanceof UsageError ? error.message : String(error);
      }
      return "parsed";
    };
    const over = String(MAX_FOLLOW_INTERVAL + 1);
    const judge = ["judge", "--keypair", "j.json", "--owner", NATIVE_MINT, "--nonce", "0", "--spec", "s.md", "--sandbox", "viper", "--watch"];
    expect(usage(["monitor", "--expect", "b.json", "--interval", over])).toBe(`--interval must be an integer from 5 to ${MAX_FOLLOW_INTERVAL}`);
    expect(usage([...judge, "--interval", over])).toBe(`--interval must be an integer from 1 to ${MAX_FOLLOW_INTERVAL}`);
    expect(usage(["events", "--follow", "--interval", over])).toBe(`--interval must be an integer from 1 to ${MAX_FOLLOW_INTERVAL}`);
    expect(usage([...judge, "--interval", String(MAX_FOLLOW_INTERVAL)])).toBe("parsed");
  });

  it("the SDK and the core share their token programs and 64-bit bound", () => {
    expect(CLIENT_PROGRAMS).toHaveLength(2);
    expect(MAX_MICRO_LAMPORTS).toBe(U64_MAX);
  });
});

const stringsOf = (value: unknown): string[] =>
  typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(stringsOf) : typeof value === "object" && value !== null ? Object.values(value).flatMap(stringsOf) : [];

function fillerRun(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "filler-env-"));
  const log = join(dir, "calls.log");
  const stub = join(dir, "cli");
  writeFileSync(log, "");
  writeFileSync(stub, `#!/usr/bin/env bash\necho "$*" >> "${log}"\n`);
  chmodSync(stub, 0o755);
  const ran = spawnSync("bash", [join(ROOT, "scripts", "filler.sh")], {
    cwd: dir,
    encoding: "utf8",
    timeout: 2500,
    env: { ...process.env, FILLER_CLI: stub, FILLER_KEYPAIR: "filler.json", ...env },
  });
  return { status: ran.status, stderr: ran.stderr, calls: readFileSync(log, "utf8") };
}

describe("numeric environment settings are refused at startup", () => {
  it.each(["abc", "0", "-5", "2.5", "3601", " 7", "99999999999999999999"])("FILLER_INTERVAL=%j is refused before anything runs", (value) => {
    const ran = fillerRun({ FILLER_INTERVAL: value });
    expect(ran.status).toBe(2);
    expect(ran.stderr).toContain("FILLER_INTERVAL");
    expect(ran.calls).toBe("");
  });

  it("FILLER_INTERVAL at its limits is passed to solve, the same limits solve enforces", () => {
    for (const value of ["1", String(MAX_FOLLOW_INTERVAL)]) {
      const ran = fillerRun({ FILLER_INTERVAL: value });
      expect(ran.stderr).not.toContain("FILLER_INTERVAL");
      expect(ran.calls).toContain(`--interval ${value}`);
      const solve = parse(ran.calls.split("\n").find((line) => line.startsWith("solve "))?.split(" ") ?? [], {});
      expect(solve).toMatchObject({ name: "solve", watch: Number(value) });
    }
  }, 15_000);

  it("FAUCET_NOW is refused when it is not a whole number", () => {
    const faucet = spawnSync("bash", [join(ROOT, "scripts", "faucet.sh")], { encoding: "utf8", timeout: 2500, env: { ...process.env, FAUCET_KEYPAIR: "k.json", FAUCET_NOW: "yesterday" } });
    expect([faucet.status, faucet.stderr]).toEqual([2, 'refusing: FAUCET_NOW is a whole number of seconds since 1970, not "yesterday"\n']);
  });

  it("DEPLOY_CU_PRICE is refused when it is not a whole number", () => {
    const hash = "0".repeat(64);
    const deploy = spawnSync("bash", [join(ROOT, "scripts", "deploy.sh"), "devnet", hash], { encoding: "utf8", timeout: 2500, env: { ...process.env, DEPLOY_CU_PRICE: "1e5" } });
    expect([deploy.status, deploy.stderr]).toEqual([2, 'refusing: DEPLOY_CU_PRICE is a whole number of micro-lamports, not "1e5"\n']);
  });

  it("the word count check refuses a timeout that is not a whole number above 0, naming the variable", () => {
    const job = join(ROOT, "examples/jobs/word-count");
    const artifact = mkdtempSync(join(tmpdir(), "word-count-env-"));
    for (const value of ["abc", "0", "-1", "1.5", "1e3"]) {
      const ran = spawnSync(process.execPath, [join(job, "check.mjs")], {
        encoding: "utf8",
        env: { PATH: process.env["PATH"] ?? "", ARTIFACT_PATH: artifact, SPEC_PATH: join(job, "SPEC.md"), WORD_COUNT_TIMEOUT_MS: value },
      });
      expect([ran.status, ran.stderr]).toEqual([2, `WORD_COUNT_TIMEOUT_MS is a whole number of milliseconds above 0, not "${value}"\n`]);
    }
  });
});
