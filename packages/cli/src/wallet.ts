import { type Address, createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder, type KeyPairSigner } from "@solana/kit";
import { getTokenDecoder } from "@solana-program/token";
import { DEVNET_TEST_MINT, findAssociatedTokenAddress, formatAmount, NATIVE_MINT, PRODUCT_REPOSITORY } from "@intent-engine/core";
import { createdAccount, mintOf, type Transport } from "@intent-engine/client";
import { CLUSTERS, ENV_KEYPAIR, ENV_URL, type Env, UsageError } from "./args.js";
import { SOL_DECIMALS } from "./agent/read.js";
import { redactUrl } from "./render.js";
import { DEVNET_URL } from "./tokens.js";

export const LAMPORTS_PER_SOL = 1_000_000_000n;
const FUND_BELOW = LAMPORTS_PER_SOL / 2n;
export const AIRDROP = LAMPORTS_PER_SOL;

type Settings = { url: string; keypair: string };

export type Files = {
  home: string;
  readText(path: string): Promise<string>;
  saveText(path: string, text: string, secret: boolean): Promise<void>;
  loadSigner(path: string): Promise<KeyPairSigner>;
  loadKeypair(path: string): Promise<Uint8Array>;
};

const settingsDir = (home: string) => `${home}/.config/intent-engine`;
export const settingsPath = (home: string) => `${settingsDir(home)}/config.json`;
export const defaultWallet = (home: string) => `${settingsDir(home)}/wallet.json`;

export const settingsBroken = (path: string) => `${path} is not a settings file this CLI wrote; delete it and run setup again`;

export const PUBLIC_FAUCET = "https://faucet.solana.com";
export const FAUCET = `${PRODUCT_REPOSITORY}/issues/new?template=faucet.yml`;
export const FUNDED = "your wallet is ready; try offering 0.05 SOL for at least 5 TEST";
export const FAUCET_FIELD = "address";
export const faucetLink = (address: string) => FAUCET + "&" + FAUCET_FIELD + "=" + encodeURIComponent(address);
export const FAUCET_STEPS = "open this link, submit the form, and run setup again once SOL arrives: ";
export const airdropRefused = (address: string) => "the airdrop was refused; " + FAUCET_STEPS + faucetLink(address);
export const SEND_SOL = "send SOL to this address, then run setup again";
export const heldRefused = (sol: string, address: string) =>
  `your wallet holds ${sol} SOL; devnet refused to add more, so if you run low ` + FAUCET_STEPS + faucetLink(address);

export function expandHome(path: string, home: string): string {
  if (path === "~") {
    return home;
  }
  return /^~[\\/]/.test(path) ? `${home}${path.slice(1)}` : path;
}

const set = (value: string | undefined) => (value === "" ? undefined : value);

export async function withSettings(files: Files, given: Env): Promise<Env> {
  const env = { ...given, [ENV_URL]: set(given[ENV_URL]), [ENV_KEYPAIR]: set(given[ENV_KEYPAIR]) };
  const path = settingsPath(files.home);
  let text: string;
  try {
    text = await files.readText(path);
  } catch {
    return env;
  }
  let saved: unknown;
  try {
    saved = JSON.parse(text);
  } catch {
    throw new UsageError(settingsBroken(path));
  }
  if (
    saved === null ||
    typeof saved !== "object" ||
    typeof (saved as Settings).url !== "string" ||
    typeof (saved as Settings).keypair !== "string"
  ) {
    throw new UsageError(settingsBroken(path));
  }
  const { url, keypair } = saved as Settings;
  return { ...env, [ENV_URL]: env[ENV_URL] ?? url, [ENV_KEYPAIR]: env[ENV_KEYPAIR] ?? keypair };
}

const alreadyExists = (error: unknown) =>
  error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST";

async function walletAt(files: Files, path: string): Promise<{ signer: KeyPairSigner; created: boolean }> {
  try {
    await files.readText(path);
  } catch {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
    try {
      await files.saveText(path, JSON.stringify([...seed, ...getAddressEncoder().encode(signer.address)]), true);
    } catch (error) {
      if (!alreadyExists(error)) {
        throw error;
      }
      return { signer: await files.loadSigner(path), created: false };
    }
    return { signer: await files.loadSigner(path), created: true };
  }
  return { signer: await files.loadSigner(path), created: false };
}

const lamportsOf = async (transport: Transport, owner: Address) => (await transport.getAccount(owner))?.lamports ?? 0n;

export const savedDefault = (url: string) => `saved ${redactUrl(url)} as the default RPC for later CLI commands`;

export const keptDefault = (saved: string) => `left the saved default RPC ${redactUrl(saved)} unchanged`;

export async function setup(
  transport: Transport,
  files: Files,
  url: string,
  keypair: string | undefined,
  keepSavedUrl = false,
): Promise<object> {
  const path = expandHome(keypair ?? defaultWallet(files.home), files.home);
  const { signer, created } = await walletAt(files, path);
  const saved = keepSavedUrl ? (await withSettings(files, {}))[ENV_URL] : undefined;
  await files.saveText(settingsPath(files.home), `${JSON.stringify({ url: saved ?? url, keypair: path }, null, 2)}\n`, false);
  let held = await lamportsOf(transport, signer.address);
  let next = FUNDED;
  if (held < FUND_BELOW) {
    if (url === CLUSTERS["mainnet-beta"]) {
      next = SEND_SOL;
    } else {
      try {
        await transport.airdrop(signer.address, AIRDROP);
        held = await lamportsOf(transport, signer.address);
      } catch {
        next = held > 0n ? heldRefused(formatAmount(held, SOL_DECIMALS), signer.address) : airdropRefused(signer.address);
      }
    }
  }
  return {
    address: signer.address,
    keypair: path,
    created,
    url: redactUrl(url),
    settings: saved === undefined ? savedDefault(url) : keptDefault(saved),
    sol: formatAmount(held, SOL_DECIMALS),
    next,
  };
}

export function defaultMints(url: string): Address[] {
  return url === DEVNET_URL ? [NATIVE_MINT, DEVNET_TEST_MINT] : [NATIVE_MINT];
}

const TOKEN_LABELS: Readonly<Record<string, string>> = { [NATIVE_MINT]: "wrapped SOL", [DEVNET_TEST_MINT]: "TEST" };

export async function balances(transport: Transport, owner: Address, mints: readonly Address[]): Promise<object> {
  const tokens = [];
  for (const mint of mints) {
    const token = await mintOf(transport, mint);
    const account = await findAssociatedTokenAddress({ owner, mint, tokenProgram: token.tokenProgram });
    const view = await createdAccount(transport, account);
    const raw = view === null ? 0n : getTokenDecoder().decode(view.data).amount;
    tokens.push({
      mint,
      ...(TOKEN_LABELS[mint] === undefined ? {} : { name: TOKEN_LABELS[mint] }),
      account,
      balance: formatAmount(raw, token.decimals),
    });
  }
  return { address: owner, sol: formatAmount(await lamportsOf(transport, owner), SOL_DECIMALS), tokens };
}
