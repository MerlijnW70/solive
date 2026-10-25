import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Address, createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder, lamports, none, some } from "@solana/kit";
import { getMintEncoder, getMintSize } from "@solana-program/token";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEVNET_TEST_MINT, findAssociatedTokenAddress, formatAmount, IntentStatus, Kind, NATIVE_MINT, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { splitFee } from "@intent-engine/core/internal";
import { type ClientOptions, createClient, type Transport } from "../src/index.js";
import { FEE_BPS, funded, world, type World } from "./svm.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const PAGE = readFileSync(`${ROOT}/docs/solver.md`, "utf8");
const DEVNET = "https://api.devnet.solana.com";
const SOL = 1_000_000_000n;

const fenced = (lang: string) => [...PAGE.matchAll(new RegExp(`^\`\`\`${lang}\\n([\\s\\S]*?)^\`\`\`$`, "gm"))].map((m) => m[1] ?? "");
const blocks = fenced("ts");

const injected = vi.hoisted(() => ({ transport: undefined as Transport | undefined, urls: [] as string[] }));

vi.mock("@intent-engine/client", async () => {
  const real = await import("../src/index.js");
  return {
    ...real,
    createClient: (options: ClientOptions) => {
      injected.urls.push(options.url);
      if (injected.transport === undefined) {
        throw new Error("no transport injected");
      }
      return real.createClient({ ...options, transport: injected.transport });
    },
  };
});

function preset(w: World, at: Address, mintAuthority: Address | null): void {
  const space = BigInt(getMintSize());
  w.chain.svm.setAccount({
    address: at,
    data: Uint8Array.from(
      getMintEncoder().encode({
        mintAuthority: mintAuthority === null ? none() : some(mintAuthority),
        supply: 0n,
        decimals: 9,
        isInitialized: true,
        freezeAuthority: none(),
      }),
    ),
    executable: false,
    lamports: lamports(w.chain.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
}

async function keyFile(home: string, file: string) {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  writeFileSync(join(home, file), JSON.stringify([...seed, ...getAddressEncoder().encode(signer.address)]));
  return signer;
}

const ata = (owner: Address, mint: Address) => findAssociatedTokenAddress({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });

describe("the solver page's TypeScript solver", () => {
  const home = mkdtempSync(join(tmpdir(), "solver-page-"));
  const pageModule = fileURLToPath(new URL(`./.solver-page-${process.pid}.ts`, import.meta.url));
  const homeVars = ["HOME", "USERPROFILE"] as const;
  const before = homeVars.map((name) => [name, process.env[name]] as const);

  beforeAll(() => {
    for (const name of homeVars) {
      process.env[name] = home;
    }
  });

  afterAll(() => {
    for (const [name, value] of before) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(pageModule, { force: true });
  });

  it("states the install, the fee recipient and the wrapped SOL payout", () => {
    expect(fenced("sh")).toContain("npm install @intent-engine/core @intent-engine/client @solana/kit @solana-program/token\n");
    expect(PAGE).toContain("passes the fee recipient the config names, the treasury wallet: the engine refuses a fill without it whenever the protocol fee is above zero.");
    expect(PAGE).toContain("Fills pay the solver in wrapped SOL, and `unwrap` closes that account");
    expect(blocks).toHaveLength(3);
  });

  it("runs every ts block in order: fills the step 3 intent, skips the rest, reads the fill and the balances", { timeout: 60_000 }, async () => {
    const w = await world();
    preset(w, NATIVE_MINT, null);
    preset(w, DEVNET_TEST_MINT, w.authority.address);
    const solver = await keyFile(home, "solive-solver.json");
    const token = (await keyFile(home, "solive-token.json")).address;
    w.chain.svm.airdrop(solver.address, lamports(SOL / 10n));
    preset(w, token, solver.address);
    injected.transport = w.chain.transport;
    const client = createClient({ url: DEVNET, transport: w.chain.transport });
    const owner = await funded(w.chain);
    const sell = (amount: bigint, outputMint: Address, minOut: bigint) =>
      client.createIntent({ signer: owner, inputMint: NATIVE_MINT, outputMint, params: { kind: Kind.SwapExactIn, amountIn: amount, minOut } });
    const step3 = await sell(SOL / 20n, token, 5n * SOL);
    const greedy = await sell(SOL / 100n, token, 3n * SOL);
    const other = await sell(SOL / 100n, DEVNET_TEST_MINT, SOL);
    expect(await client.config().then((c) => c.feeBps)).toBe(FEE_BPS);
    expect(w.chain.svm.getAccount(await ata(w.feeRecipient.address, NATIVE_MINT)).exists).toBe(false);

    const printed: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    });
    writeFileSync(pageModule, blocks.join("\n"));
    try {
      await import(pathToFileURL(pageModule).href);
    } finally {
      log.mockRestore();
      rmSync(pageModule, { force: true });
    }

    const { fee, net } = splitFee(SOL / 20n, FEE_BPS);
    expect(formatAmount(net, 9)).toBe("0.049975");
    expect(PAGE).toContain("5 and 0.049975 for the intent from step 3.");
    expect(printed).toEqual([`5 ${formatAmount(net, 9)}`, `SOL ${formatAmount(net, 9)}`, `${token} 0`, formatAmount(w.chain.svm.getBalance(solver.address) ?? 0n, 9)]);
    expect(injected.urls).toEqual([DEVNET]);
    const statuses = await Promise.all([step3, greedy, other].map(async ({ nonce }) => (await client.intent({ owner: owner.address, nonce }))?.intent.status));
    expect(statuses).toEqual([IntentStatus.Filled, IntentStatus.Open, IntentStatus.Open]);
    const tokens = await client.balances(owner.address, [token]);
    expect(tokens.tokens[0]?.amount).toBe(5n * SOL);
    const treasury = await client.balances(w.feeRecipient.address, [NATIVE_MINT]);
    expect(treasury.tokens[0]?.amount).toBe(fee);
    expect(w.chain.svm.getAccount(await ata(solver.address, NATIVE_MINT)).exists).toBe(false);
    expect(await client.fillOf(step3.intent)).toMatchObject({ steps: 1, solver: solver.address, delivered: 5n * SOL, required: 5n * SOL, fee, net });
  });
});
