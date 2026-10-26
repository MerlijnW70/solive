import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Address, createKeyPairSignerFromBytes, generateKeyPairSigner, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { beforeEach, describe, expect, it } from "vitest";
import { Kind, NATIVE_MINT } from "@intent-engine/core";
import { findIntentPda } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { CLUSTERS } from "../src/args.js";
import { SOL_AMOUNT } from "../src/arg-values.js";
import { EVERYDAY_TOOLS } from "../src/agent/everyday.js";
import { ACTIONS } from "../src/agent/registry.js";
import { MAINNET_GENESIS } from "../src/agent/wallet/guard.js";
import { GH_HINT } from "../src/faucet.js";
import { noOrder } from "../src/flows.js";
import { NO_JOB_MATCHES, NO_JOB_OPEN } from "../src/job-commands.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, ONE_NODE } from "../src/main.js";
import { faucetLink, fundingSteps, settingsPath, unfundedPreview, unfundedRefused } from "../src/wallet.js";
import { belowRent, newWalletNext, notAWalletAddress, SEND_SOL_NOT_MAINNET, sendToSelf, walletExists } from "../src/wallet-commands.js";
import { cli, h, HOME, NOW, transport, type World, world } from "./harness.js";

type Json = Record<string, unknown>;

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string) => readFileSync(`${ROOT}/${path}`, "utf8");
const DEVNET = CLUSTERS["devnet"] ?? "";
const SOL = 1_000_000_000n;

function nativeMint(): void {
  if (h.svm.getAccount(NATIVE_MINT).exists) {
    return;
  }
  const space = BigInt(getMintSize());
  h.svm.setAccount({
    address: NATIVE_MINT,
    data: Uint8Array.from(getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals: 9, isInitialized: true, freezeAuthority: none() })),
    executable: false,
    lamports: lamports(h.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
}

const lamportsOf = (address: Address) => h.svm.getBalance(address) ?? 0n;

describe("previews on a wallet without SOL", () => {
  let w: World;
  let poor: KeyPairSigner;
  let keys: Record<string, KeyPairSigner>;

  beforeEach(async () => {
    w = await world();
    nativeMint();
    poor = await generateKeyPairSigner();
    keys = { "poor.json": poor };
  });

  const swapAs = (keypair: string, ...more: string[]) => [
    "create",
    "swap",
    "--keypair",
    keypair,
    "--input-mint",
    "SOL",
    "--output-mint",
    w.outputMint,
    "--units",
    "tokens",
    "--amount-in",
    "0.05",
    "--min-out",
    "0.000005",
    "--expires-in",
    "3600",
    ...more,
  ];
  const swap = (...more: string[]) => swapAs("poor.json", ...more);

  it("shows the terms of a create swap, says it could not simulate it and how to get SOL, and sends nothing", async () => {
    expect(lamportsOf(poor.address)).toBe(0n);
    const run = await cli(swap("--url", "devnet"), keys);
    expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
    const shown = run.json();
    expect(shown).toMatchObject({ nonce: "0", sent: false, simulated: false, next: unfundedPreview(poor.address, DEVNET) });
    expect(shown["summary"]).toEqual(expect.arrayContaining([expect.stringMatching(/^Sell: exactly 0\.05 of /)]));
    expect(shown["next"]).toContain("so this preview could not be simulated");
    expect(shown["next"]).toContain(`${poor.address} holds no SOL`);
    expect(shown["next"]).toContain(GH_HINT + fundingSteps(poor.address));
    expect(shown["next"]).toContain(faucetLink(poor.address));
    expect(shown["next"]).not.toBe("Unfunded");
    expect(h.svm.getAccount(shown["intent"] as Address).exists).toBe(false);
    const elsewhere = (await cli(swap(), keys)).json();
    expect(elsewhere).toMatchObject({ sent: false, simulated: false, next: unfundedPreview(poor.address, CLUSTERS["localnet"] ?? "") });
    expect(elsewhere["next"]).toContain(`send SOL to ${poor.address}`);
  });

  it("refuses to send it with --yes and says how to get SOL", async () => {
    const run = await cli(swap("--url", "devnet", "--yes"), keys);
    expect(run.code).toBe(EXIT_FAILED);
    expect(run.err).toBe(unfundedRefused(poor.address, DEVNET));
    expect(run.err).toContain(fundingSteps(poor.address));
    expect(run.out).toBe("");
    const [intent] = await findIntentPda({ owner: poor.address, nonce: 0n });
    expect(h.svm.getAccount(intent).exists).toBe(false);
  });

  it("shows the terms of every other create kind too", async () => {
    const judge = (await generateKeyPairSigner()).address;
    const common = ["--keypair", "poor.json", "--input-mint", "SOL", "--output-mint", w.outputMint, "--units", "tokens", "--expires-in", "3600", "--url", "devnet"];
    for (const [kind, terms] of [
      ["attested", ["--amount-in", "0.01", "--min-result", "1", "--max-result", "1", "--attestor", judge, "--spec-hash", "ab".repeat(32)]],
      ["limit", ["--make", "0.05", "--take", "0.000005"]],
      ["dutch", ["--amount-in", "0.05", "--start-out", "0.00001", "--end-out", "0.000005", "--start-at", String(NOW), "--end-at", String(NOW + 600n)]],
    ] as const) {
      const run = await cli(["create", kind, ...common, ...terms], keys);
      expect([kind, run.code, run.err]).toEqual([kind, EXIT_OK, ""]);
      expect(run.json()).toMatchObject({ sent: false, simulated: false, next: unfundedPreview(poor.address, DEVNET) });
      expect((run.json()["summary"] as string[]).length).toBeGreaterThan(1);
    }
  });

  it("still simulates the preview of a wallet that holds SOL", async () => {
    const run = await cli(swapAs("owner.json", "--url", "devnet"), { "owner.json": w.owner });
    expect(run.code).toBe(EXIT_OK);
    expect(run.json()["simulated"]).toBeUndefined();
    expect(run.json()["sent"]).toBe(false);
  });

  it("is what the quickstart promises", () => {
    expect(read("docs/quickstart.md")).toContain("On a wallet without SOL it still shows the terms, says the preview could not be simulated, and repeats how to get SOL.");
  });
});

describe("refusals for orders the wallet does not have", () => {
  let w: World;

  beforeEach(async () => {
    w = await world();
  });

  it("cancel names the missing nonce and points to list, not to a derived address", async () => {
    const run = await cli(["cancel", "--keypair", "owner.json", "--nonce", "7", "--close", "--yes"], { "owner.json": w.owner });
    expect(run.code).toBe(EXIT_FAILED);
    expect(run.err).toBe(noOrder(w.owner.address, 7n));
    expect(run.err).toContain("intent-engine list");
    const [intent] = await findIntentPda({ owner: w.owner.address, nonce: 7n });
    expect(run.err).not.toContain(intent);
    expect(read("docs/quickstart.md")).toContain("A nonce your wallet has no order with is refused, with a pointer to `intent-engine list`.");
  });

  it("claims open does the same for a nonce the wallet never escrowed", async () => {
    const run = await cli(["claims", "open", "--keypair", "owner.json", "--nonce", "9", "--max-secs", "3600", "--stake", "0.05", "--yes"], { "owner.json": w.owner });
    expect(run.code).toBe(EXIT_FAILED);
    expect(run.err).toBe(noOrder(w.owner.address, 9n));
  });
});

describe("an empty job list", () => {
  let w: World;

  beforeEach(async () => {
    w = await world();
  });

  it("says no job is open, how to wait for one and how to post one", async () => {
    h.watched.push(w.owner.address);
    const empty = (await cli(["jobs"], {})).json();
    expect(empty).toEqual({ jobs: [], next: NO_JOB_OPEN });
    expect(NO_JOB_OPEN).toContain("no job is open right now");
    expect(NO_JOB_OPEN).toContain("run intent-engine jobs again in a few minutes to wait for one");
    expect(NO_JOB_OPEN).toContain("intent-engine create attested");
    const judge = (await generateKeyPairSigner()).address;
    expect((await cli(["jobs", "--attestor", judge], {})).json()).toEqual({ jobs: [], next: NO_JOB_MATCHES });
    const client = createClient({ url: "http://cluster", transport });
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge, specHash: new Uint8Array(32).fill(3), judgeFee: 0n } as const;
    await client.createIntent({ signer: w.owner, inputMint: w.inputMint, outputMint: w.outputMint, params, nonce: 1n, expiresAt: NOW + 3_600n });
    const listed = (await cli(["jobs"], {})).json();
    expect(listed["jobs"]).toHaveLength(1);
    expect(listed["next"]).toBeUndefined();
  });

  it("is what the first paid job guide and the AI page say", () => {
    expect(read("docs/first-job.md")).toContain("When no job is open, `jobs` says so in its `next`: run it again in a few minutes to wait for one, or post one yourself as step 2 does.");
    expect(read("docs/ai.md")).toContain("`find_jobs` lists open jobs, and says so when none is open: ask it to wait for one, or post one yourself as below.");
  });
});

describe("new-wallet and send-sol", () => {
  let w: World;
  const keys = (): Record<string, KeyPairSigner> => ({ "owner.json": w.owner });

  beforeEach(async () => {
    w = await world();
  });

  it("makes a key file without touching the default wallet, and never overwrites one", async () => {
    h.files.set(settingsPath(HOME), JSON.stringify({ url: DEVNET, keypair: "owner.json" }));
    const made = await cli(["new-wallet", "--out", "worker.json"], {});
    expect([made.code, made.err]).toEqual([EXIT_OK, ""]);
    const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(h.files.get("worker.json") ?? "[]") as number[]));
    expect(made.json()).toEqual({ address: signer.address, keypair: "worker.json", created: true, next: newWalletNext("worker.json") });
    expect(JSON.parse(h.files.get(settingsPath(HOME)) ?? "{}")).toEqual({ url: DEVNET, keypair: "owner.json" });
    const first = h.files.get("worker.json");
    const again = await cli(["new-wallet", "--out", "worker.json"], {});
    expect([again.code, again.err]).toEqual([EXIT_FAILED, walletExists("worker.json")]);
    expect(h.files.get("worker.json")).toBe(first);
    expect((await cli(["new-wallet", "--out", "~/keys/w.json"], {})).json()["keypair"]).toBe(`${HOME}/keys/w.json`);
    expect((await cli(["new-wallet"], {})).code).toBe(EXIT_USAGE);
  });

  it("previews a SOL transfer, sends it only with --yes, and the new wallet can sign", async () => {
    const to = (await generateKeyPairSigner()).address;
    const args = ["send-sol", "--keypair", "owner.json", "--to", to, "--amount", "0.02"];
    const before = lamportsOf(w.owner.address);
    const preview = await cli(args, keys());
    expect([preview.code, preview.err]).toEqual([EXIT_OK, ""]);
    expect(preview.json()).toMatchObject({ from: w.owner.address, to, sol: "0.02", sent: false, summary: [`Sends 0.02 SOL from ${w.owner.address} to ${to}; the sender also pays the network fee`] });
    expect(lamportsOf(to)).toBe(0n);
    expect(lamportsOf(w.owner.address)).toBe(before);
    const sent = await cli([...args, "--yes"], keys());
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(sent.json()).toMatchObject({ sent: true, signature: expect.any(String) });
    expect(lamportsOf(to)).toBe((SOL * 2n) / 100n);
  });

  it("refuses mainnet, the sender itself, accounts that are not wallets and amounts a new wallet cannot hold", async () => {
    const to = (await generateKeyPairSigner()).address;
    const send = (target: string, amount = "0.02") => cli(["send-sol", "--keypair", "owner.json", "--to", target, "--amount", amount, "--yes"], keys());
    expect((await send(w.owner.address)).err).toBe(sendToSelf(w.owner.address));
    expect((await send(w.ownerInput)).err).toBe(notAWalletAddress(w.ownerInput, TOKEN_PROGRAM_ADDRESS));
    const tiny = await send(to, "0.000000001");
    expect(tiny.code).toBe(EXIT_FAILED);
    expect(tiny.err).toBe(belowRent(to, h.svm.minimumBalanceForRentExemption(0n)));
    for (const amount of ["0", "abc", "1e3", "0.0000000001"]) {
      const bad = await send(to, amount);
      expect([amount, bad.code, bad.err]).toEqual([amount, EXIT_USAGE, SOL_AMOUNT]);
    }
    h.genesis = MAINNET_GENESIS;
    const mainnet = await send(to);
    expect([mainnet.code, mainnet.err]).toEqual([EXIT_FAILED, SEND_SOL_NOT_MAINNET]);
    expect(lamportsOf(to)).toBe(0n);
  });
});

describe("the server's note about one node, and the MCP page", () => {
  const MCP = read("docs/mcp.md");
  const AI = read("docs/ai.md");
  const section = (page: string, title: string) => page.slice(page.indexOf(`## ${title}`), page.indexOf("\n## ", page.indexOf(`## ${title}`) + 3));
  const named = (text: string) => [...text.matchAll(/`(solive_\w+)`/g)].map((m) => m[1] ?? "");

  it("reads as information and is explained where the server is set up", () => {
    const shown = "info: releases are checked against one RPC node";
    expect(ONE_NODE.startsWith(shown)).toBe(true);
    expect(ONE_NODE).not.toMatch(/error|warn/i);
    expect(ONE_NODE).toContain("--confirm-url <rpc>");
    const second = section(MCP, "A second node");
    expect(second).toContain(`starts with \`${shown}\``);
    expect(second).toContain("It is a note, not an error");
    expect(second).toContain('add `"--confirm-url", "<rpc>"` to the server\'s `args`');
    expect(second).toContain("`npx -y @intent-engine/cli setup --confirm-url <rpc>`");
    expect(AI).toContain(`it prints a line that starts with \`${shown}\`. It is a note, not an error; [A second node](mcp.md#a-second-node) shows how to set \`--confirm-url\`.`);
  });

  it("names the wallet tools add-to installs for delivering work, and the read-only server's instead", () => {
    const deliver = section(MCP, "Deliver work");
    const [steps = "", plain = ""] = deliver.split("The server without a wallet");
    expect(named(steps).filter((tool) => !EVERYDAY_TOOLS.has(tool))).toEqual([]);
    expect(named(steps)).toEqual(expect.arrayContaining(["solive_find_jobs", "solive_get_spec", "solive_wallet_claim", "solive_wallet_deliver", "solive_wallet_check_delivery", "solive_wallet_receipt"]));
    const readOnly = new Set(ACTIONS.map((action) => action.name));
    const instead = named(plain).filter((tool) => !tool.startsWith("solive_wallet_"));
    expect(instead).toEqual(["solive_prepare_deliver", "solive_check_delivery", "solive_get_receipt"]);
    expect(instead.filter((tool) => !readOnly.has(tool) || EVERYDAY_TOOLS.has(tool))).toEqual([]);
    expect(deliver).toContain("With `--wallet`, the setup `add-to` installs");
  });

  it("asks for the host app before add-to, and the readme points at the funding section", () => {
    expect(AI).toContain("installed first: `add-to` runs that app's own command.");
    expect(read("README.md")).toContain("[Devnet SOL](docs/quickstart.md#devnet-sol)");
    expect(read("docs/quickstart.md")).toContain("\n## Devnet SOL\n");
  });
});
