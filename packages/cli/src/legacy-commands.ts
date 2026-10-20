import type { Address } from "@solana/kit";
import {
  type BoardTerms,
  boardTerms,
  buildCloseLegacy,
  findVaultPda,
  getIntentDecoder,
  INTENT_DISCRIMINATOR,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  IntentStatus,
  isCurrentAccount,
  legacyStakeTo,
  lineIntent,
  migratesInPlace,
  recordedPayer,
  storedVersion,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from "@intent-engine/core";
import { chainTime, createdAccount, loadConfig, type Transport } from "@intent-engine/client";
import type { Command } from "./command-types.js";
import type { Runtime } from "./runtime.js";
import { previewed } from "./admin-commands.js";
import { transactionSigner } from "./ledger-keys.js";

type CloseLegacy = Extract<Command, { name: "close-legacy" }>;

const isIntent = (data: Uint8Array) => INTENT_DISCRIMINATOR.every((b, i) => data[i] === b);

async function escrowOpen(transport: Transport, intent: Address, now: bigint): Promise<boolean> {
  const view = await createdAccount(transport, intent);
  if (view === null || view.owner !== INTENT_ENGINE_PROGRAM_ADDRESS || !isIntent(view.data)) {
    return false;
  }
  const stored = storedVersion(view.data);
  if (stored === null || stored.version < stored.layout.oldest || stored.version > stored.layout.version) {
    return false;
  }
  const held = getIntentDecoder().decode(view.data);
  return held.status === IntentStatus.Open && now < held.expiresAt;
}

async function stakeOf(transport: Transport, terms: BoardTerms | null): Promise<Address | null> {
  if (terms === null) {
    return null;
  }
  const now = await chainTime(transport);
  return legacyStakeTo(terms, await escrowOpen(transport, terms.intent, now), now);
}

export async function closeLegacy(command: CloseLegacy, runtime: Runtime, transport: Transport): Promise<object> {
  const payer = await transactionSigner(runtime, command.keypair);
  const account = command.address;
  const view = await createdAccount(transport, account);
  if (view === null) {
    throw new Error(`${account} does not exist`);
  }
  if (view.owner !== INTENT_ENGINE_PROGRAM_ADDRESS) {
    throw new Error(`${account} is not an engine account; close-legacy closes only accounts the engine program owns`);
  }
  const stored = storedVersion(view.data);
  if (isCurrentAccount(view.data)) {
    throw new Error(`${account} is a current ${stored?.layout.name ?? "engine"} account; close-legacy closes only accounts of an earlier layout or version`);
  }
  if (migratesInPlace(view.data)) {
    throw new Error(`${account} is a ${stored?.layout.name ?? "engine"} account, which is upgraded in place and never closed`);
  }
  const line = lineIntent(view.data);
  if (line !== null && (await escrowOpen(transport, line, await chainTime(transport)))) {
    throw new Error(
      `${account} is an outdated ${stored?.layout.name ?? "line"} account of escrow ${line}, which is still open; closing it would drop its place in the line, so upgrade it with intent-engine migrate instead`,
    );
  }
  const intent = isIntent(view.data);
  const [vault] = await findVaultPda({ intent: account });
  const vaultView = intent ? await createdAccount(transport, vault) : null;
  if (vaultView !== null && [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS].includes(vaultView.owner) && vaultView.data.length > 0) {
    throw new Error(`the vault ${vault} of intent ${account} still holds its escrow; cancel, expire or close the intent first so its owner gets every token back`);
  }
  const recorded = recordedPayer(view.data);
  const recordedView = recorded === null ? null : await createdAccount(transport, recorded);
  const unpayable = recordedView?.executable === true;
  const config = recorded === null || unpayable ? await loadConfig(transport) : null;
  const payee = recorded ?? config?.config.feeRecipient;
  if (payee === undefined) {
    throw new Error(`no wallet to pay for ${account}`);
  }
  const rentTo = unpayable ? config?.config.feeRecipient : payee;
  if (rentTo === undefined) {
    throw new Error(`no wallet to pay for ${account}`);
  }
  const terms = boardTerms(view.data);
  const receiver = await stakeOf(transport, terms);
  const stakeTo = receiver === null || receiver === rentTo ? null : receiver;
  const stake = stakeTo === null ? 0n : (terms?.held ?? 0n);
  const instruction = await buildCloseLegacy({
    account,
    payee,
    ...(config === null ? {} : { config: config.address }),
    ...(intent ? { vault } : {}),
    ...(line === null ? {} : { intent: line }),
    ...(stakeTo === null ? {} : { stakeTo }),
    ...(unpayable ? { feeTo: rentTo } : {}),
  });
  const what =
    stored === null
      ? `an engine account of ${view.data.length} bytes that matches no account type`
      : `an outdated ${stored.layout.name} account: version ${stored.version}, ${view.data.length} bytes; the current one is version ${stored.layout.version}, ${stored.layout.space} bytes`;
  const rest = view.lamports - stake;
  const share = stake === 0n ? `all its ${rest}` : `the other ${rest}`;
  const why = unpayable
    ? `the config's fee recipient, since ${payee}, which its layout records as the payer, cannot hold lamports`
    : recorded === null
      ? "the config's fee recipient, since its layout records no payer"
      : "the wallet its layout records as the one that paid for it";
  const summary = [
    `Closes ${account}, ${what}`,
    ...(stakeTo === null ? [] : [`Pays the ${stake} lamports of claim stake it holds to ${stakeTo}, as settling the claim would`]),
    `Sends ${share} lamports to ${rentTo}, ${why}`,
  ];
  return previewed(transport, [instruction], payer, { account, payee: rentTo, lamports: view.lamports, summary }, command.yes);
}
