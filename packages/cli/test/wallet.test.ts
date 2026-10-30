import {
  type Address,
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressEncoder,
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
  AIRDROPS,
  airdropRefused,
  CLI_SMALL_START,
  CLI_START,
  FAUCET,
  faucetLink,
  defaultWallet,
  ENOUGH_TO_START,
  GH_WAY,
  heldRefused,
  otherWays,
  pasteAt,
  holdsEnough,
  LAMPORTS_PER_SOL,
  refusedEnough,
  savedDefault,
  SEND_SOL,
  settingsBroken,
  settingsPath,
  setup,
} from "../src/wallet.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, main } from "../src/main.js";
import { GH_HINT } from "../src/faucet.js";
import { balance, cli, funded, h, HOME, runtime, transport, type World, world } from "./harness.js";
import { device, deviceKey, found } from "./ledger-device.js";

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
    expect(made).toMatchObject({ keypair: WALLET, created: true, url: DEVNET_URL, sol: "1", next: holdsEnough("1", CLI_START) });
    expect(h.urls.at(-1)).toBe(DEVNET_URL);
    expect(JSON.parse(h.files.get(WALLET) ?? "[]")).toHaveLength(64);
    expect(JSON.parse(h.files.get(SETTINGS) ?? "{}")).toEqual({ url: DEVNET_URL, keypair: WALLET });
    const address = made["address"] as Address;
    expect(h.airdrops).toEqual([{ address, lamports: AIRDROP }]);
    expect(h.svm.getBalance(address)).toBe(LAMPORTS_PER_SOL);
    const again = (await cli(["setup"], {})).json();
    expect(again).toMatchObject({ address, keypair: WALLET, created: false, sol: "1", next: holdsEnough("1", CLI_START) });
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
        { mint: NATIVE_MINT, name: "wrapped SOL", balance: "0" },
        { mint: TEST_TOKEN, name: "TEST", balance: "0" },
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

  it("points to the faucet when the airdrop is refused on a low balance, and never airdrops on mainnet", async () => {
    h.airdropRefused = true;
    const refused = (await cli(["setup"], {})).json();
    const address = refused["address"] as Address;
    expect(refused).toMatchObject({ created: true, sol: "0", next: airdropRefused(address) });
    expect(refused["next"]).toBe(
      "your wallet holds no SOL yet and devnet refused the airdrop; paste " + address + " at https://" + "faucet.solana.com, which sends at once when it accepts, then run setup again",
    );
    expect(refused["other_ways"]).toEqual([
      "open " + FAUCET + "&address=" + address +
        " to file a faucet request in a browser, as a public GitHub issue that needs a GitHub account; the faucet answers new requests at least every 15 minutes, so SOL arrives within 25 minutes",
      GH_WAY,
    ]);
    h.svm.airdrop(address, lamports(LAMPORTS_PER_SOL / 50n));
    expect((await cli(["setup"], {})).json()).toMatchObject({ created: false, sol: "0.02", next: heldRefused("0.02", address) });
    expect(h.airdrops).toHaveLength(2 * AIRDROPS.length);
    expect(heldRefused("0.02", address).endsWith(pasteAt(address))).toBe(true);
    expect(otherWays(address, GH_HINT)[0]).toContain(faucetLink(address));
    h.svm.airdrop(address, lamports(LAMPORTS_PER_SOL / 4n));
    expect((await cli(["setup"], {})).json()).toMatchObject({ created: false, sol: "0.27", next: refusedEnough("0.27", CLI_START) });
    expect(h.airdrops).toHaveLength(3 * AIRDROPS.length);
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

  it("a wallet created by another process is loaded", async () => {
    const seed = new Uint8Array(32).fill(5);
    const other = await createKeyPairSignerFromPrivateKeyBytes(seed);
    const theirs = JSON.stringify([...seed, ...getAddressEncoder().encode(other.address)]);
    const raced = (code: string) => ({
      ...runtime({}),
      saveText: async (path: string, text: string, secret: boolean) => {
        if (secret) {
          h.files.set(path, theirs);
          throw Object.assign(new Error(`${code}: ${path}`), { code });
        }
        h.files.set(path, text);
      },
    });
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["setup"], raced("EEXIST"), { out: (t) => out.push(t), err: (t) => err.push(t) });
    expect([code, err]).toEqual([EXIT_OK, []]);
    expect(JSON.parse(out.join("\n"))).toMatchObject({ address: other.address, keypair: WALLET, created: false });
    expect(h.files.get(WALLET)).toBe(theirs);
    expect(JSON.parse(h.files.get(SETTINGS) ?? "{}")).toEqual({ url: DEVNET_URL, keypair: WALLET });
    clean();
    const denied: string[] = [];
    expect(await main(["setup"], raced("EACCES"), { out: () => undefined, err: (t) => denied.push(t) })).toBe(EXIT_FAILED);
    expect(denied).toEqual([`EACCES: ${WALLET}`]);
  });

  it("setup with --url saves the new node over the one saved before", async () => {
    expect((await cli(["setup"], {})).code).toBe(EXIT_OK);
    const moved = await cli(["setup", "--url", "http://flag"], {});
    expect([moved.code, moved.err]).toEqual([EXIT_OK, ""]);
    expect(moved.json()).toMatchObject({ created: false, url: "http://flag", settings: savedDefault("http://flag") });
    expect(JSON.parse(h.files.get(SETTINGS) ?? "{}")).toEqual({ url: "http://flag", keypair: WALLET });
  });

  it("a refused airdrop leaves a wallet holding exactly enough to start ready", async () => {
    h.airdropRefused = true;
    const made = (await cli(["setup"], {})).json();
    const address = made["address"] as Address;
    h.svm.airdrop(address, lamports(ENOUGH_TO_START));
    expect((await cli(["setup"], {})).json()).toMatchObject({ created: false, sol: "0.06", next: refusedEnough("0.06", CLI_SMALL_START) });
  });

  it("setup on a Ledger names the device's address and creates no key file", async () => {
    const key = await deviceKey();
    const ledger = device(key, found([44, 501], key));
    const made = await setup(transport, { ...runtime({}), ledger: ledger.open }, "http://flag", "usb://ledger");
    expect(made).toMatchObject({ address: key.address, keypair: "usb://ledger", created: false });
    expect(h.files.has("usb://ledger")).toBe(false);
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
    const refunded = await cli(["cancel", "--keypair", "owner.json", "--nonce", "0", "--yes"], keys);
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
