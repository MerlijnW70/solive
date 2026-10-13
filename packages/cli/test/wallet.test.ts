import {
  type Address,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  lamports,
  none,
} from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { findAssociatedTokenAddress } from "@intent-engine/core";
import { beforeEach, describe, expect, it } from "vitest";
import { CLUSTERS, ENV_KEYPAIR, ENV_URL, parse, UsageError } from "../src/args.js";
import { DEVNET_TEST_MINT as TEST_TOKEN, NATIVE_MINT } from "@intent-engine/core";
import { DEVNET_URL, testTokenElsewhere, tokenNamed } from "../src/tokens.js";
import {
  AIRDROP,
  AIRDROP_REFUSED,
  defaultWallet,
  FUNDED,
  LAMPORTS_PER_SOL,
  SEND_SOL,
  settingsBroken,
  settingsPath,
} from "../src/wallet.js";
import { EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { balance, cli, funded, h, HOME, type World, world } from "./harness.js";

const WALLET = defaultWallet(HOME);
const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;
const SETTINGS = settingsPath(HOME);

function preset(at: Address, decimals = 9): void {
  const space = BigInt(getMintSize());
  h.svm.setAccount({
    address: at,
    data: Uint8Array.from(
      getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals, isInitialized: true, freezeAuthority: none() }),
    ),
    executable: false,
    lamports: lamports(h.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
}

const wrappedOf = (owner: Address) => findAssociatedTokenAddress({ owner, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });

function programsOfLastSend(): Address[] {
  const message = getCompiledTransactionMessageDecoder().decode(
    getTransactionDecoder().decode(getBase64Encoder().encode(h.wires.at(-1) ?? "")).messageBytes,
  );
  const compiled = (message as unknown as { instructions: { programAddressIndex: number }[] }).instructions;
  return compiled.map((ix) => message.staticAccounts[ix.programAddressIndex] as Address);
}

function clean(): void {
  h.files.clear();
  for (const name of Object.keys(h.env)) {
    delete h.env[name];
  }
}

describe("token names", () => {
  it("name wrapped SOL anywhere and the test token only on devnet", () => {
    expect(tokenNamed("SOL", CLUSTERS["localnet"] ?? "")).toBe(NATIVE_MINT);
    expect(tokenNamed("sol", DEVNET_URL)).toBe(NATIVE_MINT);
    expect(tokenNamed("TEST", DEVNET_URL)).toBe(TEST_TOKEN);
    expect(tokenNamed("test", DEVNET_URL)).toBe(TEST_TOKEN);
    expect(tokenNamed("TEST", CLUSTERS["mainnet-beta"] ?? "")).toEqual(new Error(testTokenElsewhere(CLUSTERS["mainnet-beta"] ?? "")));
    expect(tokenNamed(TEST_TOKEN, CLUSTERS["mainnet-beta"] ?? "")).toBe(TEST_TOKEN);
  });

  it("stand in for mint addresses in every mint option and read amounts as tokens unless told raw", () => {
    const created = parse(
      ["create", "swap", "--keypair", "k", "--url", "devnet", "--input-mint", "SOL", "--output-mint", "TEST", "--expires-in", "60", "--amount-in", "0.05", "--min-out", "5"],
      {},
    );
    expect(created).toMatchObject({
      input: {
        input_mint: NATIVE_MINT,
        output_mint: TEST_TOKEN,
        order: { kind: "swap", amount_in: { tokens: "0.05", side: "input" }, min_out: { tokens: "5", side: "output" } },
      },
    });
    expect(parse(["approve", "--keypair", "k", "--mint", "sol", "--amount", "7", "--units", "raw"], {})).toMatchObject({
      input: { mint: NATIVE_MINT, amount: "7" },
    });
    expect(parse(["treasury", "--url", "devnet", "--mints", "SOL, TEST"], {})).toMatchObject({ mints: [NATIVE_MINT, TEST_TOKEN] });
    expect(() => parse(["approve", "--keypair", "k", "--mint", "TEST", "--amount", "1"], {})).toThrow(
      new UsageError(testTokenElsewhere(CLUSTERS["localnet"] ?? "")),
    );
  });
});

describe("setup and balance", () => {
  let w: World;

  beforeEach(async () => {
    w = await world();
    clean();
  });

  it("creates, saves and funds a devnet wallet once, then every command uses it", async () => {
    const first = await cli(["setup"], {});
    expect(first.err).toBe("");
    const made = first.json();
    expect(made).toMatchObject({ keypair: WALLET, created: true, url: DEVNET_URL, sol: "1", next: FUNDED });
    expect(h.urls.at(-1)).toBe(DEVNET_URL);
    expect(JSON.parse(h.files.get(WALLET) ?? "[]")).toHaveLength(64);
    expect(JSON.parse(h.files.get(SETTINGS) ?? "{}")).toEqual({ url: DEVNET_URL, keypair: WALLET });
    const address = made["address"] as Address;
    expect(h.airdrops).toEqual([{ address, lamports: AIRDROP }]);
    expect(h.svm.getBalance(address)).toBe(LAMPORTS_PER_SOL);
    const again = (await cli(["setup"], {})).json();
    expect(again).toMatchObject({ address, keypair: WALLET, created: false, sol: "1", next: FUNDED });
    expect(h.airdrops).toHaveLength(1);
    preset(NATIVE_MINT);
    preset(TEST_TOKEN);
    const held = await cli(["balance"], {});
    expect(held.err).toBe("");
    expect(h.urls.at(-1)).toBe(DEVNET_URL);
    expect(held.json()).toEqual({
      address,
      sol: "1",
      tokens: [
        { mint: NATIVE_MINT, name: "wrapped SOL", account: await wrappedOf(address), balance: "0" },
        {
          mint: TEST_TOKEN,
          name: "TEST",
          account: await findAssociatedTokenAddress({ owner: address, mint: TEST_TOKEN, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
          balance: "0",
        },
      ],
    });
  });

  it("lets flags and the environment override what setup saved", async () => {
    await cli(["setup"], {});
    const other = await funded();
    h.env[ENV_URL] = "localnet";
    await cli(["balance", "--owner", other.address], {});
    expect(h.urls.at(-1)).toBe(CLUSTERS["localnet"]);
    await cli(["balance", "--owner", other.address, "--url", "http://flag"], {});
    expect(h.urls.at(-1)).toBe("http://flag");
    h.env[ENV_KEYPAIR] = "elsewhere.json";
    const shown = (await cli(["balance", "--mints", w.inputMint], { "elsewhere.json": w.owner })).json();
    expect(shown).toMatchObject({ address: w.owner.address, tokens: [{ mint: w.inputMint, balance: "0.001" }] });
    expect((await cli(["balance", "--keypair", "elsewhere.json", "--owner", other.address], { "elsewhere.json": w.owner })).code).toBe(
      EXIT_USAGE,
    );
  });

  it("points to the faucet when the airdrop is refused and never airdrops on mainnet", async () => {
    h.airdropRefused = true;
    expect((await cli(["setup"], {})).json()).toMatchObject({ created: true, sol: "0", next: AIRDROP_REFUSED });
    clean();
    h.airdrops.length = 0;
    expect((await cli(["setup", "--url", "mainnet-beta", "--keypair", "main.json"], {})).json()).toMatchObject({
      keypair: "main.json",
      url: CLUSTERS["mainnet-beta"],
      sol: "0",
      next: SEND_SOL,
    });
    expect(h.airdrops).toEqual([]);
    expect(JSON.parse(h.files.get(SETTINGS) ?? "{}")).toEqual({ url: CLUSTERS["mainnet-beta"], keypair: "main.json" });
  });

  it("treats an empty environment variable as unset, before and after setup", async () => {
    h.env[ENV_URL] = "";
    h.env[ENV_KEYPAIR] = "";
    const made = await cli(["setup"], {});
    expect(made.err).toBe("");
    expect(made.json()).toMatchObject({ keypair: WALLET, url: DEVNET_URL, created: true });
    preset(NATIVE_MINT);
    preset(TEST_TOKEN);
    const held = await cli(["balance"], {});
    expect(held.err).toBe("");
    expect(held.json()["address"]).toBe(made.json()["address"]);
    expect(h.urls.at(-1)).toBe(DEVNET_URL);
  });

  it("refuses a settings file it did not write", async () => {
    for (const text of ["not json", "[]", JSON.stringify({ url: 1, keypair: "k" })]) {
      h.files.set(SETTINGS, text);
      const ran = await cli(["balance"], {});
      expect(ran.code).toBe(EXIT_USAGE);
      expect(ran.err).toBe(settingsBroken(SETTINGS));
    }
  });
});

describe("selling SOL", () => {
  let w: World;

  beforeEach(async () => {
    w = await world();
    clean();
    preset(NATIVE_MINT);
  });

  const swap = (...rest: string[]) => [
    "create",
    "swap",
    "--keypair",
    "owner.json",
    "--input-mint",
    "SOL",
    "--output-mint",
    w.outputMint,
    "--expires-in",
    "3600",
    "--amount-in",
    "0.05",
    "--min-out",
    "0.000005",
    ...rest,
  ];

  it("wraps only the SOL the escrow is short of, in the same transaction", async () => {
    const keys = { "owner.json": w.owner };
    const escrow = LAMPORTS_PER_SOL / 20n;
    const preview = await cli(swap(), keys);
    expect(preview.err).toBe("");
    expect(preview.json()).toMatchObject({ escrow: escrow.toString(), wraps: escrow.toString(), sent: false });
    expect(preview.json()["summary"]).toContain("Setup: wraps 0.05 of your SOL into your wrapped SOL account");
    const before = h.svm.getBalance(w.owner.address) ?? 0n;
    const made = await cli(swap("--yes"), keys);
    expect(made.err).toBe("");
    expect(made.code).toBe(EXIT_OK);
    const wrapped = await wrappedOf(w.owner.address);
    expect(balance(wrapped)).toBe(0n);
    expect(before - (h.svm.getBalance(w.owner.address) ?? 0n) > escrow).toBe(true);
  });

  it("wraps nothing when the wrapped SOL account already holds the escrow, and a mandate wraps its whole budget", async () => {
    const keys = { "owner.json": w.owner };
    await cli(swap("--yes"), keys);
    const wrapped = await wrappedOf(w.owner.address);
    const refunded = await cli(["cancel", "--keypair", "owner.json", "--nonce", "0"], keys);
    expect(refunded.err).toBe("");
    expect(balance(wrapped)).toBe(LAMPORTS_PER_SOL / 20n);
    expect((await cli(swap(), keys)).json()).toMatchObject({ wraps: "0" });
    expect((await cli(swap("--yes"), keys)).err).toBe("");
    expect(programsOfLastSend().filter((p) => p === TOKEN_PROGRAM_ADDRESS || p === SYSTEM_PROGRAM)).toEqual([]);
    expect(balance(wrapped)).toBe(0n);
    const agent = await funded();
    const grant = await cli(
      [
        "mandate",
        "grant",
        "--keypair",
        "owner.json",
        "--agent",
        agent.address,
        "--input-mint",
        "SOL",
        "--output-mint",
        w.outputMint,
        "--kinds",
        "swap",
        "--per-intent",
        "0.05",
        "--total",
        "0.2",
        "--max-intents",
        "4",
        "--max-ttl",
        "3600",
        "--valid-for",
        "3600",
        "--floor-out",
        "1",
        "--floor-in",
        "1",
        "--yes",
      ],
      keys,
    );
    expect(grant.err).toBe("");
    expect(grant.json()["summary"]).toContain("Setup: wraps 0.2 of your SOL into your wrapped SOL account");
    expect(balance(wrapped)).toBe(LAMPORTS_PER_SOL / 5n);
  });
});
