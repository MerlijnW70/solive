import { type Address, createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder, type KeyPairSigner } from "@solana/kit";
import { getTokenDecoder } from "@solana-program/token";
import { DEVNET_TEST_MINT, findAssociatedTokenAddress, formatAmount, NATIVE_MINT } from "@intent-engine/core";
import { PRODUCT_REPOSITORY } from "@intent-engine/core/internal";
import { type Transport } from "@intent-engine/client";
import { ledgerSigner, openUsb } from "@intent-engine/client/node";
import { createdAccount, isLedgerPath, mintOf, type OpenTransport } from "@intent-engine/client/internal";
import { CLUSTERS, ENV_KEYPAIR, ENV_URL, type Env, UsageError } from "./args.js";
import { SAVED_CONFIRM_URL } from "./clusters.js";
import { SOL_DECIMALS } from "./agent/read.js";
import { redactUrl } from "./render.js";
import { DEVNET_URL } from "./tokens.js";
import { FAUCET_POLL_SECONDS, FAUCET_SCHEDULE, FAUCET_WAIT_MINUTES, faucetPending, faucetWaiting, fileFaucetRequest, GH_HINT, type Launch } from "./faucet.js";

export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const FUND_BELOW = LAMPORTS_PER_SOL / 2n;
export const ENOUGH_TO_START = (LAMPORTS_PER_SOL * 6n) / 100n;
export const SWAP_START = LAMPORTS_PER_SOL / 10n;
export const AIRDROP = LAMPORTS_PER_SOL;
export const AIRDROPS: readonly bigint[] = [AIRDROP, AIRDROP / 2n, AIRDROP / 4n, AIRDROP / 10n];

type Settings = { url: string; keypair: string; [SAVED_CONFIRM_URL]?: string };

export type Files = {
  home: string;
  readText(path: string): Promise<string>;
  saveText(path: string, text: string, secret: boolean): Promise<void>;
  loadSigner(path: string): Promise<KeyPairSigner>;
  loadKeypair(path: string): Promise<Uint8Array>;
  ledger?: OpenTransport;
};

export const settingsDir = (home: string) => `${home}/.config/intent-engine`;
export const settingsPath = (home: string) => `${settingsDir(home)}/config.json`;
export const defaultWallet = (home: string) => `${settingsDir(home)}/wallet.json`;
export const ledgerBook = (home: string, path: string) => `${settingsDir(home)}/${path.replace(/[^A-Za-z0-9]+/g, "-")}.sales.json`;

export const settingsBroken = (path: string) => `${path} is not a settings file this CLI wrote; delete it and run setup again`;

export const PUBLIC_FAUCET = "https://faucet.solana.com";
export const FAUCET = `${PRODUCT_REPOSITORY}/issues/new?template=faucet.yml`;
export const CLI_START = "try offering 0.05 SOL for at least 5 TEST";
const solOf = (lamports: bigint) => formatAmount(lamports, SOL_DECIMALS);
export const CLI_SMALL_START = `follow the first paid job guide; a 0.05 SOL swap needs ${solOf(SWAP_START)} SOL`;
export const smallerAirdrop = (got: bigint) => `devnet refused ${solOf(AIRDROP)} SOL and sent ${solOf(got)} SOL; `;
export const holdsEnough = (sol: string, start: string) => `your wallet holds ${sol} SOL, enough to start; ${start}`;
export const refusedEnough = (sol: string, start: string) => `devnet refused more free SOL, but your wallet holds ${sol} SOL, enough to start; ${start}`;
export const FAUCET_FIELD = "address";
export const faucetLink = (address: string) => FAUCET + "&" + FAUCET_FIELD + "=" + encodeURIComponent(address);
export const OTHER_FAUCETS = `or ask another devnet faucet, such as ${PUBLIC_FAUCET}, which sends at once when it accepts`;
export const fundingSteps = (address: string) =>
  `open ${faucetLink(address)} to file a faucet request in a browser, as a public GitHub issue that needs a GitHub account; ${FAUCET_SCHEDULE}; ${OTHER_FAUCETS}`;
export const SETUP_AGAIN = "; run setup again once SOL arrives";
export const airdropRefused = (address: string, hint = "") => "your wallet holds no SOL yet and devnet refused the airdrop, as it often does; " + hint + fundingSteps(address) + SETUP_AGAIN;
const getSol = (address: string, url: string) => (url === DEVNET_URL ? `get devnet SOL: ${GH_HINT}${fundingSteps(address)}` : `send SOL to ${address}`);
export const unfundedPreview = (address: string, url: string) =>
  `nothing was sent: ${address} holds no SOL, so this preview could not be simulated; ${getSol(address, url)}; then run this again with --yes`;
export const unfundedRefused = (address: string, url: string) =>
  `nothing was sent: ${address} holds no SOL to pay the network fee; ${getSol(address, url)}; then run this again`;
export const SEND_SOL = "send SOL to this address, then run setup again";
export const heldRefused = (sol: string, address: string, hint = "") =>
  `your wallet holds ${sol} SOL, less than the ${solOf(ENOUGH_TO_START)} SOL setup counts as enough to start, and devnet refused to add more; ` + hint + fundingSteps(address) + SETUP_AGAIN;

export type FaucetRun = { file: boolean; launch: Launch; sleep(seconds: number): Promise<boolean>; now(): bigint; note(text: string): void };

export function expandHome(path: string, home: string): string {
  if (path === "~") {
    return home;
  }
  return /^~[\\/]/.test(path) ? `${home}${path.slice(1)}` : path;
}

const set = (value: string | undefined) => (value === "" ? undefined : value);

export async function withSettings(files: Files, given: Env): Promise<Env> {
  const env = { ...given, [ENV_URL]: set(given[ENV_URL]), [ENV_KEYPAIR]: set(given[ENV_KEYPAIR]), [SAVED_CONFIRM_URL]: undefined };
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
    typeof (saved as Settings).keypair !== "string" ||
    !["string", "undefined"].includes(typeof (saved as Settings)[SAVED_CONFIRM_URL])
  ) {
    throw new UsageError(settingsBroken(path));
  }
  const { url, keypair, [SAVED_CONFIRM_URL]: confirmUrl } = saved as Settings;
  return { ...env, [ENV_URL]: env[ENV_URL] ?? url, [ENV_KEYPAIR]: env[ENV_KEYPAIR] ?? keypair, [SAVED_CONFIRM_URL]: confirmUrl };
}

const alreadyExists = (error: unknown) =>
  error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST";

async function walletAt(files: Files, path: string): Promise<{ signer: { address: Address }; created: boolean }> {
  if (isLedgerPath(path)) {
    return { signer: await ledgerSigner(path, files.ledger ?? openUsb), created: false };
  }
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

async function airdropped(transport: Transport, owner: Address): Promise<bigint | undefined> {
  for (const amount of AIRDROPS) {
    try {
      await transport.airdrop(owner, amount);
      return amount;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function arrived(transport: Transport, owner: Address, faucet: FaucetRun): Promise<bigint> {
  const until = faucet.now() + BigInt(FAUCET_WAIT_MINUTES * 60);
  let held = await lamportsOf(transport, owner);
  while (held < ENOUGH_TO_START && faucet.now() < until && (await faucet.sleep(FAUCET_POLL_SECONDS))) {
    held = await lamportsOf(transport, owner);
  }
  return held;
}

export const savedDefault = (url: string) => `saved ${redactUrl(url)} as the default RPC for later CLI commands`;

export const keptDefault = (saved: string) => `left the saved default RPC ${redactUrl(saved)} unchanged`;

const savedConfirm = async (files: Files): Promise<string | undefined> => {
  try {
    return (await withSettings(files, {}))[SAVED_CONFIRM_URL];
  } catch {
    return undefined;
  }
};

export class SecondNodeRefused extends Error {}

export const confirmUnreachable = (url: string, reason: string): string =>
  `--confirm-url ${redactUrl(url)} could not be read (${reason}), so it was not saved; name a node that answers`;

export const confirmElsewhere = (url: string, first: string, second: string): string =>
  `--confirm-url ${redactUrl(url)} serves another cluster than --url: genesis hash ${second}, not ${first}, so it was not saved; name a node on the same cluster`;

async function checkedSecond(transport: Transport, confirm: Transport, url: string): Promise<void> {
  let second: string;
  try {
    second = await confirm.genesisHash();
  } catch (error) {
    throw new SecondNodeRefused(confirmUnreachable(url, error instanceof Error ? error.message : String(error)));
  }
  const first = await transport.genesisHash();
  if (second !== first) {
    throw new SecondNodeRefused(confirmElsewhere(url, first, second));
  }
}

export async function setup(
  transport: Transport,
  files: Files,
  url: string,
  keypair: string | undefined,
  keepSavedUrl = false,
  confirmUrl?: string,
  confirmTransport?: Transport,
  start = CLI_START,
  smallStart = start,
  faucet?: FaucetRun,
): Promise<object> {
  if (confirmUrl !== undefined && confirmTransport !== undefined) {
    await checkedSecond(transport, confirmTransport, confirmUrl);
  }
  const path = expandHome(keypair ?? defaultWallet(files.home), files.home);
  const { signer, created } = await walletAt(files, path);
  const saved = keepSavedUrl ? (await withSettings(files, {}))[ENV_URL] : undefined;
  const confirm = confirmUrl ?? (await savedConfirm(files));
  const settings: Settings = { url: saved ?? url, keypair: path, ...(confirm === undefined ? {} : { [SAVED_CONFIRM_URL]: confirm }) };
  await files.saveText(settingsPath(files.home), `${JSON.stringify(settings, null, 2)}\n`, false);
  let held = await lamportsOf(transport, signer.address);
  let refused = false;
  let got: bigint | undefined;
  if (held < FUND_BELOW && url !== CLUSTERS["mainnet-beta"]) {
    got = await airdropped(transport, signer.address);
    refused = got === undefined;
    held = await lamportsOf(transport, signer.address);
  }
  let hint = faucet === undefined || url !== DEVNET_URL ? "" : GH_HINT;
  let filed: string | undefined;
  if (faucet?.file === true && held < ENOUGH_TO_START) {
    const request = await fileFaucetRequest(faucet.launch, signer.address);
    if ("url" in request) {
      filed = request.url;
      faucet.note(faucetWaiting(filed));
      held = await arrived(transport, signer.address, faucet);
    } else {
      hint = request.hint;
    }
  }
  const sol = solOf(held);
  const smaller = got === undefined || got === AIRDROP ? "" : smallerAirdrop(got);
  const next =
    url === CLUSTERS["mainnet-beta"] && held < FUND_BELOW
      ? SEND_SOL
      : held >= ENOUGH_TO_START
        ? smaller + (refused ? refusedEnough : holdsEnough)(sol, held >= SWAP_START ? start : smallStart)
        : filed !== undefined
          ? faucetPending(filed)
          : held > 0n
            ? heldRefused(sol, signer.address, hint)
            : airdropRefused(signer.address, hint);
  return {
    address: signer.address,
    keypair: path,
    created,
    url: redactUrl(url),
    settings: saved === undefined ? savedDefault(url) : keptDefault(saved),
    ...(confirm === undefined ? {} : { confirm_url: redactUrl(confirm) }),
    sol,
    ...(got === undefined ? {} : { airdrop: solOf(got) }),
    ...(filed === undefined ? {} : { faucet_request: filed }),
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
      ...(view === null ? {} : { account }),
      balance: formatAmount(raw, token.decimals),
    });
  }
  return { address: owner, sol: formatAmount(await lamportsOf(transport, owner), SOL_DECIMALS), tokens };
}
