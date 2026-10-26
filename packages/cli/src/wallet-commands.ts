import { type Address, createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder } from "@solana/kit";
import { getTransferSolInstruction, SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { formatAmount } from "@intent-engine/core";
import { type Transport } from "@intent-engine/client";
import { rentExemptFor, rentSysvar, TOKEN_PROGRAMS } from "@intent-engine/client/internal";
import { previewed } from "./admin-commands.js";
import { SOL_DECIMALS } from "./agent/read.js";
import { MAINNET_GENESIS } from "./agent/wallet/guard.js";
import type { Command } from "./command-types.js";
import { FlowRefused } from "./flows.js";
import type { Runtime } from "./runtime.js";
import { expandHome } from "./wallet.js";

export const SEND_SOL_NOT_MAINNET = "send-sol works on devnet, testnet and localnet only, never mainnet; nothing was sent";

export const walletExists = (path: string) => `${path} already exists, so it was left as it is; choose another --out`;

export const newWalletNext = (path: string) =>
  `send it devnet SOL with intent-engine send-sol --to <address> --amount <SOL>, then pass --keypair ${path} to act as this wallet; your default wallet stays the one setup saved`;

export const sendToSelf = (address: Address) => `--to ${address} is the sending wallet itself; nothing was sent`;

export const notAWalletAddress = (to: Address, owner: Address) =>
  `--to ${to} is ${TOKEN_PROGRAMS.includes(owner) ? "a token account" : `an account of the program ${owner}`}, not a wallet, so SOL sent there could not be spent; give a wallet address. Nothing was sent`;

export const belowRent = (to: Address, least: bigint) =>
  `${to} holds no SOL yet, and a new wallet needs at least ${formatAmount(least, SOL_DECIMALS)} SOL to exist; send at least that much. Nothing was sent`;

const alreadyExists = (error: unknown) => error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST";

export async function newWallet(out: string, runtime: Runtime): Promise<object> {
  const path = expandHome(out, runtime.home);
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const exists = await runtime.readText(path).then(
    () => true,
    () => false,
  );
  if (exists) {
    throw new FlowRefused(walletExists(path));
  }
  try {
    await runtime.saveText(path, JSON.stringify([...seed, ...getAddressEncoder().encode(signer.address)]), true);
  } catch (error) {
    throw alreadyExists(error) ? new FlowRefused(walletExists(path)) : error;
  }
  return { address: signer.address, keypair: path, created: true, next: newWalletNext(path) };
}

type SendSol = Extract<Command, { name: "send-sol" }>;

export async function sendSol(command: SendSol, runtime: Runtime, transport: Transport): Promise<object> {
  if ((await transport.genesisHash()) === MAINNET_GENESIS) {
    throw new FlowRefused(SEND_SOL_NOT_MAINNET);
  }
  const source = await runtime.loadSigner(command.keypair);
  if (command.to === source.address) {
    throw new FlowRefused(sendToSelf(command.to));
  }
  const held = await transport.getAccount(command.to);
  if (held !== null && held.owner !== SYSTEM_PROGRAM_ADDRESS) {
    throw new FlowRefused(notAWalletAddress(command.to, held.owner));
  }
  if (held === null) {
    const least = rentExemptFor(await rentSysvar(transport), 0);
    if (command.lamports < least) {
      throw new FlowRefused(belowRent(command.to, least));
    }
  }
  const sol = formatAmount(command.lamports, SOL_DECIMALS);
  const summary = [`Sends ${sol} SOL from ${source.address} to ${command.to}; the sender also pays the network fee`];
  const instruction = getTransferSolInstruction({ source, destination: command.to, amount: command.lamports });
  return previewed(transport, [instruction], source, { from: source.address, to: command.to, sol, summary }, command.yes);
}
