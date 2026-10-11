import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Address, generateKeyPairSigner, type KeyPairSigner, lamports, none, some } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { findAssociatedTokenAddress, getIntentDecoder, getIntentSize } from "@intent-engine/core";
import {
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintEncoder,
  getMintSize,
  getSyncNativeInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { beforeEach, describe, expect, it } from "vitest";
import { CLUSTERS, ENV_KEYPAIR, ENV_URL, WATCH_INTERVAL } from "../src/args.js";
import { REVOKE_CANCELS } from "../src/agent/mandate.js";
import { ata, balance, cli, funded, h, send, type World, world } from "./harness.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string) => readFileSync(`${ROOT}/${path}`, "utf8");
const PAGE = read("docs/quickstart.md");
const NATIVE_MINT = "So11111111111111111111111111111111111111112" as Address;
const LAMPORTS_PER_SOL = 1_000_000_000n;
const WALLET = "~/solive-wallet.json";
const FILLER = read("scripts/filler.sh");
const FILLER_INTERVAL = /^interval="\$\{FILLER_INTERVAL:-(\d+)\}"$/m.exec(FILLER)?.[1] ?? "";
const variable = (name: string) => new RegExp(`^${name}=(\\S+)$`, "m").exec(FILLER)?.[1] ?? "missing";
const TEST_TOKEN = variable("test_token") as Address;
const FILLER_KEY = "filler.json";

const blocks = [...PAGE.matchAll(/^```sh\n([\s\S]*?)^```$/gm)].map((m) => (m[1] ?? "").trimEnd().split("\n"));
const lines = blocks.flat();
const commands = lines.filter((l) => l.startsWith("intent-engine "));
const setup = lines.filter((l) => !l.startsWith("intent-engine "));

function preset(at: Address, mintAuthority: Address | null): void {
  if (h.svm.getAccount(at).exists) {
    return;
  }
  const data = Uint8Array.from(
    getMintEncoder().encode({
      mintAuthority: mintAuthority === null ? none() : some(mintAuthority),
      supply: 0n,
      decimals: 9,
      isInitialized: true,
      freezeAuthority: none(),
    }),
  );
  const space = BigInt(getMintSize());
  h.svm.setAccount({
    address: at,
    data,
    executable: false,
    lamports: lamports(h.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
}

const nativeMint = () => preset(NATIVE_MINT, null);

function fillerSolve(): string[] {
  const line = FILLER.split("\n").find((l) => l.trim().startsWith('"${cli[@]}" solve')) ?? "";
  return line
    .trim()
    .replace('"${cli[@]}" ', "")
    .replaceAll('"$url"', "devnet")
    .replaceAll('"$keypair"', FILLER_KEY)
    .replaceAll("$wrapped_sol", variable("wrapped_sol"))
    .replaceAll("$test_token", TEST_TOKEN)
    .replaceAll('"$interval"', FILLER_INTERVAL)
    .replaceAll('"', "")
    .replace(/ &$/, "")
    .split(" ");
}

async function filler(): Promise<KeyPairSigner> {
  const key = await funded();
  preset(TEST_TOKEN, key.address);
  await ata(key, key.address, TEST_TOKEN);
  return key;
}

describe("the quickstart", () => {
  let w: World;

  beforeEach(async () => {
    w = await world();
  });

  it("asks for the tool versions and repository the workspace declares", () => {
    const root = JSON.parse(read("package.json")) as { engines: { node: string }; packageManager: string };
    const [, major, minor] = /^>=(\d+)\.(\d+)\.0$/.exec(root.engines.node) ?? [];
    expect(PAGE).toContain(`- Node.js ${major}.${minor} or later\n`);
    expect(PAGE).toContain(`- pnpm ${root.packageManager.replace("pnpm@", "")}\n`);
    const repository = /^repository = "([^"]+)"$/m.exec(read("identity.toml"))?.[1];
    const bin = (JSON.parse(read("packages/cli/package.json")) as { bin: Record<string, string> }).bin["intent-engine"] ?? "";
    expect(bin).toBe("./dist/src/bin.js");
    expect(CLUSTERS["devnet"]).toBe("https://api.devnet.solana.com");
    expect(setup).toEqual([
      `git clone ${repository}.git`,
      "cd solive",
      "pnpm install",
      "pnpm -r build",
      `alias intent-engine="node $PWD/packages/cli/${bin.replace("./", "")}"`,
      `solana-keygen new --no-bip39-passphrase -o ${WALLET}`,
      `solana config set --url devnet --keypair ${WALLET}`,
      `export ${ENV_URL}=devnet ${ENV_KEYPAIR}=${WALLET}`,
      "solana airdrop 1",
      "spl-token wrap 0.2",
      `spl-token balance ${TEST_TOKEN}`,
    ]);
  });

  it("names the token and rate the devnet filler runs with", () => {
    expect(variable("wrapped_sol")).toBe(NATIVE_MINT);
    expect(PAGE).toContain(`The intent sells wrapped SOL for the solive test token \`${TEST_TOKEN}\`.`);
    expect(commands.filter((c) => c.includes(" create ")).every((c) => c.includes(`--input-mint ${NATIVE_MINT} --output-mint ${TEST_TOKEN} `))).toBe(true);
    expect(fillerSolve()).toEqual([
      "solve",
      "--url",
      "devnet",
      "--keypair",
      FILLER_KEY,
      "--issue",
      `${NATIVE_MINT}:${TEST_TOKEN}=200/1`,
      "--min-profit",
      `${TEST_TOKEN}=1`,
      "--watch",
      "--interval",
      "5",
    ]);
    expect(PAGE).toContain(
      "The devnet filler prices test tokens at 200 per wrapped SOL and pays exactly the minimum asked, so it fills this intent with 5.",
    );
  });

  it("creates an intent the filler fills, then cancels one it does not, with exactly the commands it prints", async () => {
    const owner = await funded();
    nativeMint();
    const wrapped = await findAssociatedTokenAddress({ owner: owner.address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const rent = h.svm.minimumBalanceForRentExemption(165n);
    await send(owner, [
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: owner, owner: owner.address, mint: NATIVE_MINT }),
      getTransferSolInstruction({ source: owner, destination: wrapped, amount: LAMPORTS_PER_SOL / 5n - rent }),
      getSyncNativeInstruction({ account: wrapped }),
    ]);
    const key = await filler();
    await ata(w.authority, w.feeRecipient.address, NATIVE_MINT);
    h.env[ENV_URL] = "devnet";
    h.env[ENV_KEYPAIR] = WALLET;
    h.watched.push(owner.address);
    const keys = { [WALLET]: owner, [FILLER_KEY]: key };
    const received = await findAssociatedTokenAddress({ owner: owner.address, mint: TEST_TOKEN, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const held = balance(wrapped);
    const outputs: Record<string, unknown>[] = [];
    const balances: bigint[] = [];
    let filled: Record<string, unknown> = {};
    for (const [index, line] of commands.entries()) {
      const run = await cli(line.split(" ").slice(1), keys);
      expect(run.err, line).toBe("");
      outputs.push(run.json());
      balances.push(balance(wrapped));
      if (index === 1) {
        filled = (await cli(fillerSolve(), keys)).json();
      }
    }
    expect(commands.map((c) => c.split(" ").slice(1, 3).join(" "))).toEqual([
      "create swap",
      "create swap",
      "create swap",
      "list",
      "cancel --nonce",
    ]);
    expect(PAGE).toContain("Sell 0.05 wrapped SOL for at least 5 test tokens:");
    expect(commands[0]).toContain("--units tokens --amount-in 0.05 --min-out 5 --expires-in 3600");
    expect(commands[1]).toBe(`${commands[0]} --yes`);
    expect(outputs[0]).toMatchObject({ sent: false });
    expect(outputs[1]).toMatchObject({ sent: true });
    expect(filled).toMatchObject({ sent: [{ intent: outputs[1]?.["intent"] }], failed: [] });
    expect(PAGE).toContain("Once the intent is filled, this prints `5`.");
    expect(balance(received)).toBe(5n * LAMPORTS_PER_SOL);
    expect(PAGE).toContain("Ask for 50 test tokens, more than the filler pays, then cancel:");
    expect(commands[2]).toContain("--units tokens --amount-in 0.05 --min-out 50 --expires-in 3600 --yes");
    expect(balances).toEqual([
      held,
      held - LAMPORTS_PER_SOL / 20n,
      held - LAMPORTS_PER_SOL / 10n,
      held - LAMPORTS_PER_SOL / 10n,
      held - LAMPORTS_PER_SOL / 20n,
    ]);
    expect(PAGE).toContain("`list` shows this intent as `open` with nonce `1`.");
    expect(outputs[3]).toMatchObject({ intents: [{ status: "filled", nonce: "0" }, { status: "open", nonce: "1" }] });
    expect(PAGE).toContain("`cancel` sends at once and returns its 0.05 wrapped SOL to your wrapped SOL token account.");
    expect(balance(received)).toBe(5n * LAMPORTS_PER_SOL);
  });
});

const MANDATE = read("docs/mandate.md");
const AGENT = "~/solive-agent.json";
const mandateLines = [...MANDATE.matchAll(/^```sh\n([\s\S]*?)^```$/gm)].flatMap((m) => (m[1] ?? "").trimEnd().split("\n"));

describe("the mandate guide", () => {
  let w: World;

  beforeEach(async () => {
    w = await world();
  });

  it("grants, uses and revokes a mandate with exactly the commands it prints", async () => {
    expect(mandateLines.filter((l) => !l.startsWith("intent-engine "))).toEqual([
      `solana-keygen new --no-bip39-passphrase -o ${AGENT}`,
      `solana transfer $(solana-keygen pubkey ${AGENT}) 0.05 --allow-unfunded-recipient`,
    ]);
    const owner = await funded();
    const agent = await generateKeyPairSigner();
    h.svm.airdrop(agent.address, lamports(LAMPORTS_PER_SOL / 20n));
    nativeMint();
    const wrapped = await findAssociatedTokenAddress({ owner: owner.address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const rent = h.svm.minimumBalanceForRentExemption(165n);
    await send(owner, [
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: owner, owner: owner.address, mint: NATIVE_MINT }),
      getTransferSolInstruction({ source: owner, destination: wrapped, amount: LAMPORTS_PER_SOL / 10n - rent }),
      getSyncNativeInstruction({ account: wrapped }),
    ]);
    preset(TEST_TOKEN, w.authority.address);
    const testMint = TEST_TOKEN;
    h.env[ENV_URL] = "devnet";
    h.env[ENV_KEYPAIR] = WALLET;
    h.watched.push(owner.address);
    const keys = { [WALLET]: owner, [AGENT]: agent };
    const held = balance(wrapped);
    const outputs: Record<string, unknown>[] = [];
    const balances: bigint[] = [];
    const sol: [bigint, bigint][] = [];
    for (const line of mandateLines.filter((l) => l.startsWith("intent-engine "))) {
      const argv = line
        .replace(`$(solana-keygen pubkey ${AGENT})`, agent.address)
        .replace("$(solana address)", owner.address)
        .split(" ")
        .slice(1);
      const run = await cli(argv, keys);
      expect(run.err, line).toBe("");
      outputs.push(run.json());
      balances.push(balance(wrapped));
      sol.push([h.svm.getBalance(owner.address) ?? 0n, h.svm.getBalance(agent.address) ?? 0n]);
    }
    expect(outputs.map((o) => o["sent"])).toEqual([true, undefined, true, true]);
    expect(MANDATE).toContain("The agent key pays the rent, network fees, create fee and crank bounty of every intent it creates:");
    const [[ownerBefore, agentBefore], [ownerAfter, agentAfter]] = [sol[1] ?? [0n, 0n], sol[2] ?? [0n, 0n]];
    const rents = h.svm.minimumBalanceForRentExemption(BigInt(getIntentSize())) + rent;
    expect(ownerAfter).toBe(ownerBefore);
    expect(agentBefore - agentAfter >= rents).toBe(true);
    expect(MANDATE).toContain("Proceeds always go to your own token account.");
    const intent = h.svm.getAccount(outputs[2]?.["intent"] as Address);
    if (!intent.exists) {
      throw new Error("agent intent missing");
    }
    const receiver = await findAssociatedTokenAddress({ owner: owner.address, mint: testMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(getIntentDecoder().decode(intent.data).receiver).toBe(receiver);
    const grant = mandateLines.find((l) => l.startsWith("intent-engine mandate grant")) ?? "";
    for (const option of [...MANDATE.matchAll(/^- `(--[a-z-]+ [0-9.]+)`(?: and `(--[a-z-]+ [0-9.]+)`)?/gm)].flatMap((m) => [m[1], m[2]])) {
      if (option !== undefined) {
        expect(grant).toContain(option);
      }
    }
    expect(MANDATE).toContain("- `--floor-out 100 --floor-in 1`: the lowest price, here 100 test tokens per wrapped SOL");
    expect(outputs[1]).toMatchObject({
      status: "active",
      kinds: ["swap"],
      per_intent: String(LAMPORTS_PER_SOL / 50n),
      total: String(LAMPORTS_PER_SOL / 20n),
      max_intents: 3,
      max_ttl: "3600",
      floor: { out: String(100n * LAMPORTS_PER_SOL), in: String(LAMPORTS_PER_SOL) },
    });
    expect(MANDATE).toContain("The 0.02 wrapped SOL moves from your token account into the intent's escrow.");
    expect(balances[2]).toBe(held - LAMPORTS_PER_SOL / 50n);
    expect(MANDATE).toContain(`Revoking cancels up to ${REVOKE_CANCELS} of the agent's open intents in the same transaction, refunds their escrow`);
    expect(balances[3]).toBe(held);
    const listed = (await cli(["list"], keys)).json() as { intents: { status: string }[] };
    expect(listed.intents.map((i) => i.status)).toEqual(["cancelled"]);
    expect(MANDATE).toContain("Revoking closes the mandate, so `mandate show` then reports `NotFound`.");
    const shown = await cli(["mandate", "show", "--agent", agent.address], keys);
    expect(shown.err.startsWith("NotFound:")).toBe(true);
  });
});

const SOLVER_PAGE = read("docs/solver.md");
const SOLVER = "~/solive-solver.json";
const SOLVER_ADDRESS = `$(solana-keygen pubkey ${SOLVER})`;
const TOKEN_KEY = "~/solive-token.json";
const solverLines = [...SOLVER_PAGE.matchAll(/^```sh\n([\s\S]*?)^```$/gm)].flatMap((m) => (m[1] ?? "").trimEnd().split("\n"));

describe("the solver guide", () => {
  let w: World;

  beforeEach(async () => {
    w = await world();
  });

  it("issues a token and fills an intent for it with exactly the commands it prints", async () => {
    expect(solverLines.filter((l) => !l.startsWith("intent-engine "))).toEqual([
      `solana-keygen new --no-bip39-passphrase -o ${SOLVER}`,
      `solana transfer ${SOLVER_ADDRESS} 0.03 --allow-unfunded-recipient`,
      `solana-keygen new --no-bip39-passphrase -o ${TOKEN_KEY}`,
      `spl-token create-token --decimals 9 ${TOKEN_KEY} --fee-payer ${SOLVER} --mint-authority ${SOLVER_ADDRESS}`,
      `export TOKEN=$(solana-keygen pubkey ${TOKEN_KEY})`,
      "spl-token balance $TOKEN",
      `spl-token balance $TOKEN --owner ${SOLVER_ADDRESS}`,
      `spl-token balance ${NATIVE_MINT} --owner ${SOLVER_ADDRESS}`,
    ]);
    expect(SOLVER_PAGE).toContain("Do steps 1 to 4 of the [quickstart](quickstart.md) first, in the same terminal.");
    const owner = await funded();
    const solver = await funded();
    const token = (await generateKeyPairSigner()).address;
    nativeMint();
    preset(token, solver.address);
    const wrapped = await findAssociatedTokenAddress({ owner: owner.address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const rent = h.svm.minimumBalanceForRentExemption(165n);
    await send(owner, [
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: owner, owner: owner.address, mint: NATIVE_MINT }),
      getTransferSolInstruction({ source: owner, destination: wrapped, amount: LAMPORTS_PER_SOL / 5n - rent }),
      getSyncNativeInstruction({ account: wrapped }),
    ]);
    await ata(w.authority, w.feeRecipient.address, NATIVE_MINT);
    h.env[ENV_URL] = "devnet";
    h.env[ENV_KEYPAIR] = WALLET;
    h.watched.push(owner.address);
    const keys = { [WALLET]: owner, [SOLVER]: solver };
    const held = balance(wrapped);
    const commands = solverLines.filter((l) => l.startsWith("intent-engine "));
    expect(commands.map((c) => c.split(" ").slice(1, 2).join(" "))).toEqual(["create", "solve"]);
    const outputs: Record<string, unknown>[] = [];
    for (const line of commands) {
      const run = await cli(line.replaceAll("$TOKEN", token).split(" ").slice(1), keys);
      expect(run.err, line).toBe("");
      outputs.push(run.json());
    }
    expect(SOLVER_PAGE).toContain("Sell 0.05 wrapped SOL for at least 5 of your token:");
    expect(commands[0]).toContain("--units tokens --amount-in 0.05 --min-out 5 --expires-in 3600 --yes");
    expect(outputs[0]).toMatchObject({ sent: true });
    expect(commands[1]).toContain(`--issue ${NATIVE_MINT}:$TOKEN=200/1 --min-profit $TOKEN=1`);
    expect(SOLVER_PAGE).toContain("`--issue` prices 200 of your token per wrapped SOL and mints them into the fill.");
    expect(SOLVER_PAGE).toContain(`at least every \`--interval\` seconds (default ${WATCH_INTERVAL})`);
    expect(FILLER_INTERVAL).toBe(String(WATCH_INTERVAL));
    expect(outputs[1]).toMatchObject({ filled: [{ intent: outputs[0]?.["intent"] }], failed: [] });
    expect(balance(wrapped)).toBe(held - LAMPORTS_PER_SOL / 20n);
    const received = await findAssociatedTokenAddress({ owner: owner.address, mint: token, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(SOLVER_PAGE).toContain("Your wallet prints `5`.");
    expect(balance(received)).toBe(5n * LAMPORTS_PER_SOL);
    const kept = await findAssociatedTokenAddress({ owner: solver.address, mint: token, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const paid = await findAssociatedTokenAddress({ owner: solver.address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const fee = balance(await findAssociatedTokenAddress({ owner: w.feeRecipient.address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS }));
    expect(SOLVER_PAGE).toContain("The solver keeps the rest of what it minted as its profit, and receives the escrowed wrapped SOL less the protocol fee.");
    expect(balance(paid)).toBe(LAMPORTS_PER_SOL / 20n - fee);
    expect(balance(kept)).toBe((balance(paid) * 200n) - 5n * LAMPORTS_PER_SOL);
    expect(SOLVER_PAGE).toContain("The solver must be a different key from the owner of the intents it fills.");
    const ownToken = (await generateKeyPairSigner()).address;
    preset(ownToken, owner.address);
    const again = (await cli(commands[0]?.replaceAll("$TOKEN", ownToken).split(" ").slice(1) ?? [], keys)).json();
    const own = (await cli((commands[1] ?? "").replaceAll("$TOKEN", ownToken).replace(SOLVER, WALLET).split(" ").slice(1), keys)).json() as {
      filled: unknown[];
      failed: { intent: string; error: string }[];
    };
    expect(own.filled).toEqual([]);
    expect(own.failed.map((f) => f.intent)).toEqual([again["intent"]]);
    expect(own.failed[0]?.error).toMatch(/index: 3, error: InstructionErrorCustom \{ code: 2040 \} \}$/);
  });
});
