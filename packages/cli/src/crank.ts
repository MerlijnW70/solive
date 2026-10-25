import { type Address, createAddressWithSeed, type Instruction, isSome, type TransactionSigner } from "@solana/kit";
import { getCreateAccountWithSeedInstruction } from "@solana-program/system";
import {
  AccountState,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeAccount3Instruction,
  getTokenDecoder,
} from "@solana-program/token";
import { findAssociatedTokenAddress, type Intent } from "@intent-engine/core";
import { buildCloseIntent, buildExpireIntent, decodeIntentAccount, findDelegatePda, findVaultPda, INTENT_VERSION, isUnreadableAccount } from "@intent-engine/core/internal";
import { type AccountView, type Transport } from "@intent-engine/client";
import { chainTime, createdAccount, EXTENSIONS_OFFSET, tokenProgramOf } from "@intent-engine/client/internal";
import { STATUS } from "./accounts.js";
import { rentFor, rentRate } from "./agent/budget.js";

export async function vaultBalance(transport: Transport, intent: Address): Promise<bigint> {
  const [vault] = await findVaultPda({ intent });
  const view = await createdAccount(transport, vault);
  return view === null ? 0n : getTokenDecoder().decode(view.data).amount;
}

async function vaultHolds(transport: Transport, intent: Address): Promise<boolean> {
  return (await vaultBalance(transport, intent)) > 0n;
}

export const UNFUNDED =
  "the owner's canonical token account is missing or cannot take a refund; pass --fund-accounts to pay for one that can";

export const TOKEN_ACCOUNT_BYTES = 165;
export const IMMUTABLE_OWNER = 7;

function onlyImmutableOwner(data: Uint8Array): boolean {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let at = EXTENSIONS_OFFSET; at + 4 <= data.length; at += 4 + view.getUint16(at + 2, true)) {
    if (view.getUint16(at, true) !== IMMUTABLE_OWNER) {
      return false;
    }
  }
  return true;
}

export function refundable(view: AccountView | null, owner: Address, mint: Address, tokenProgram: Address, engine: Address): boolean {
  if (view === null || view.owner !== tokenProgram || view.data.length < TOKEN_ACCOUNT_BYTES) {
    return false;
  }
  const token = getTokenDecoder().decode(view.data);
  return (
    token.mint === mint &&
    token.owner === owner &&
    token.state === AccountState.Initialized &&
    (!isSome(token.delegate) || token.delegate.value === engine) &&
    (!isSome(token.closeAuthority) || token.closeAuthority.value === owner) &&
    onlyImmutableOwner(view.data)
  );
}

export class UnfundedAccount extends Error {
  constructor(message: string = UNFUNDED) {
    super(message);
    this.name = "UnfundedAccount";
  }
}

export type Funding = "never" | "covered" | "always";

export const fundingRent = async (transport: Transport): Promise<bigint> => rentFor(TOKEN_ACCOUNT_BYTES, await rentRate(transport));

export const costlyFunding = (bounty: bigint, rent: bigint): string =>
  `recreating the owner's token account costs ${rent} lamports of rent, more than this intent's ${bounty} lamport bounty; settle it with expire or close to pay that knowingly`;

export class CostlyFunding extends UnfundedAccount {
  constructor(bounty: bigint, rent: bigint) {
    super(costlyFunding(bounty, rent));
    this.name = "CostlyFunding";
  }
}

const SEED_PART = 16;

export const refundSeed = (owner: Address, mint: Address): string => owner.slice(0, SEED_PART) + mint.slice(0, SEED_PART);

async function refundTarget(
  transport: Transport,
  payer: TransactionSigner,
  owner: Address,
  mint: Address,
  tokenProgram: Address,
  fund: Funding,
  bounty: bigint,
): Promise<{ prep: Instruction[]; refundTo: Address }> {
  const canonical = await findAssociatedTokenAddress({ owner, mint, tokenProgram });
  const view = await createdAccount(transport, canonical);
  const [engine] = await findDelegatePda({ owner });
  if (refundable(view, owner, mint, tokenProgram, engine)) {
    return { prep: [], refundTo: canonical };
  }
  if (fund === "never") {
    throw new UnfundedAccount();
  }
  const rent = await fundingRent(transport);
  const pay = () => {
    if (fund === "covered" && bounty < rent) {
      throw new CostlyFunding(bounty, rent);
    }
  };
  if (view === null) {
    pay();
    return {
      prep: [await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner, mint, tokenProgram })],
      refundTo: canonical,
    };
  }
  const seed = refundSeed(owner, mint);
  const spare = await createAddressWithSeed({ baseAddress: payer.address, programAddress: tokenProgram, seed });
  if (refundable(await createdAccount(transport, spare), owner, mint, tokenProgram, engine)) {
    return { prep: [], refundTo: spare };
  }
  pay();
  return {
    prep: [
      getCreateAccountWithSeedInstruction({
        payer,
        newAccount: spare,
        baseAccount: payer,
        base: payer.address,
        seed,
        amount: rent,
        space: TOKEN_ACCOUNT_BYTES,
        programAddress: tokenProgram,
      }),
      getInitializeAccount3Instruction({ account: spare, mint, owner }, { programAddress: tokenProgram }),
    ],
    refundTo: spare,
  };
}

export async function expiring(
  transport: Transport,
  cranker: TransactionSigner,
  address: Address,
  intent: Intent,
  fund: Funding,
  andClose: boolean,
) {
  const tokenProgram = await tokenProgramOf(transport, intent.inputMint);
  const ref = { owner: intent.owner, nonce: intent.nonce, inputMint: intent.inputMint, tokenProgram, capped: intent.capped };
  const bounty = BigInt(intent.bounty);
  const { prep, refundTo } = await refundTarget(transport, cranker, intent.owner, intent.inputMint, tokenProgram, fund, bounty);
  const ix = await buildExpireIntent({ ...ref, cranker, refundTo });
  const close = andClose ? [await buildCloseIntent({ ...ref, cranker, rentPayer: intent.rentPayer, refundTo })] : [];
  return [...prep, ix, ...close];
}

export async function closing(
  transport: Transport,
  payer: TransactionSigner,
  address: Address,
  intent: Intent,
  fund: Funding,
) {
  const tokenProgram = await tokenProgramOf(transport, intent.inputMint);
  const target = (await vaultHolds(transport, address))
    ? await refundTarget(transport, payer, intent.owner, intent.inputMint, tokenProgram, fund, BigInt(intent.bounty))
    : { prep: [], refundTo: undefined };
  const ix = await buildCloseIntent({
    cranker: payer,
    owner: intent.owner,
    nonce: intent.nonce,
    inputMint: intent.inputMint,
    tokenProgram,
    rentPayer: intent.rentPayer,
    capped: intent.capped,
    ...(target.refundTo === undefined ? {} : { refundTo: target.refundTo }),
  });
  return [...target.prep, ix];
}

type CrankAction = {
  intent: Address;
  action: "expire" | "close";
  signature?: string;
  error?: string;
  skipped?: string;
};

export function crankAction(intent: Intent, now: bigint, cranker?: Address): "expire" | "close" | undefined {
  if (intent.version !== INTENT_VERSION) {
    return undefined;
  }
  const status = STATUS[intent.status];
  if (status === "open") {
    return now >= intent.expiresAt ? "expire" : undefined;
  }
  if (status === "cancelled") {
    return intent.rentPayer === cranker ? "close" : undefined;
  }
  return status === "filled" || status === "expired" ? "close" : undefined;
}

export async function crank(transport: Transport, cranker: TransactionSigner, dryRun: boolean, fund: boolean) {
  const now = await chainTime(transport);
  const actions: CrankAction[] = [];
  const unreadable: { intent: Address; skipped: string }[] = [];
  let untouched = 0;
  const funding: Funding = fund ? "covered" : "never";
  for (const { address, data } of await transport.intents()) {
    let intent: Intent;
    try {
      intent = decodeIntentAccount(data);
    } catch (error) {
      if (!isUnreadableAccount(error)) {
        throw error;
      }
      unreadable.push({ intent: address, skipped: error.message });
      continue;
    }
    const action = crankAction(intent, now, cranker.address);
    if (action === undefined) {
      untouched += 1;
      continue;
    }
    if (dryRun) {
      actions.push({ intent: address, action });
      continue;
    }
    try {
      const ixs =
        action === "expire"
          ? await expiring(transport, cranker, address, intent, funding, true)
          : await closing(transport, cranker, address, intent, funding);
      actions.push({ intent: address, action, signature: await transport.send(ixs, cranker) });
    } catch (error) {
      if (error instanceof UnfundedAccount) {
        actions.push({ intent: address, action, skipped: error.message });
      } else {
        actions.push({ intent: address, action, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { now, dryRun, untouched, actions, ...(unreadable.length === 0 ? {} : { unreadable }) };
}
