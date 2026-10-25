import { type Address, createNoopSigner, type KeyPairSigner } from "@solana/kit";
import { getTokenDecoder } from "@solana-program/token";
import { formatAmount } from "@intent-engine/core";
import { readIntentAccounts, type UnreadableAccount } from "@intent-engine/core/internal";
import { type Transport } from "@intent-engine/client";
import { createdAccount, loadConfig, mintOf, rentExemptMinimum, tokenAccountIfMissing } from "@intent-engine/client/internal";
import { prepare } from "./agent/prepare.js";
import { SOL_DECIMALS } from "./agent/read.js";
import { preparedView } from "./agent/shapes.js";
import { finish } from "./flows.js";

export { SOL_DECIMALS };

type TreasuryToken = {
  mint: Address;
  token_program: Address;
  decimals: number;
  account: Address;
  exists: boolean;
  balance: bigint;
  balance_tokens: string;
};

type TreasuryView = {
  fee_recipient: Address;
  lamports: bigint;
  sol: string;
  tokens: TreasuryToken[];
  missing: Address[];
  warnings: string[];
};

export const TREASURY_IS_PROGRAM =
  "the treasury is a program account, which cannot receive SOL, so the engine withholds every create fee; point fee_recipient at a wallet or multisig vault";

export const treasuryTooEmpty = (fee: number, short: bigint) =>
  `the treasury holds too little SOL to take a ${fee} lamport create fee and stay rent-exempt, so the engine withholds that fee; send it at least ${short} lamports`;

async function createFeeWarnings(transport: Transport, owner: Address, createFee: number): Promise<string[]> {
  const account = await transport.getAccount(owner);
  if (account?.executable === true) {
    return [TREASURY_IS_PROGRAM];
  }
  if (createFee === 0) {
    return [];
  }
  const held = account?.lamports ?? 0n;
  const minimum = await rentExemptMinimum(transport, account?.data.length ?? 0);
  const short = minimum - held - BigInt(createFee);
  return short > 0n ? [treasuryTooEmpty(createFee, short)] : [];
}

export const intentLeftOut = ({ address, reason }: UnreadableAccount) => `the intent ${address} was left out of the token list: ${reason}`;

export async function intentInputMints(transport: Transport): Promise<{ mints: Address[]; unreadable: UnreadableAccount[] }> {
  const { intents, unreadable } = readIntentAccounts(await transport.intents());
  return { mints: [...new Set(intents.map(({ intent }) => intent.inputMint))].sort(), unreadable };
}

export async function treasuryView(transport: Transport, mints: readonly Address[], unreadable: readonly UnreadableAccount[] = []): Promise<TreasuryView> {
  const { config } = await loadConfig(transport);
  const owner = config.feeRecipient;
  const lamports = (await transport.getAccount(owner))?.lamports ?? 0n;
  const tokens: TreasuryToken[] = [];
  for (const mint of mints) {
    const token = await mintOf(transport, mint);
    const { address } = await tokenAccountIfMissing(transport, createNoopSigner(owner), owner, mint, token.tokenProgram);
    const view = await createdAccount(transport, address);
    const balance = view === null ? 0n : getTokenDecoder().decode(view.data).amount;
    tokens.push({
      mint,
      token_program: token.tokenProgram,
      decimals: token.decimals,
      account: address,
      exists: view !== null,
      balance,
      balance_tokens: formatAmount(balance, token.decimals),
    });
  }
  return {
    fee_recipient: owner,
    lamports,
    sol: formatAmount(lamports, SOL_DECIMALS),
    tokens,
    missing: tokens.filter((t) => !t.exists).map((t) => t.mint),
    warnings: [...(await createFeeWarnings(transport, owner, config.createFee)), ...unreadable.map(intentLeftOut)],
  };
}

export const NOTHING_TO_CREATE = "nothing to create: the treasury already holds an account for every token listed";

export async function createTreasuryAccounts(
  transport: Transport,
  view: TreasuryView,
  payer: KeyPairSigner,
  yes: boolean,
): Promise<object> {
  const absent = view.tokens.filter((t) => !t.exists);
  if (absent.length === 0) {
    return { ...view, sent: false, next: NOTHING_TO_CREATE };
  }
  const instructions = [];
  for (const t of absent) {
    const { create } = await tokenAccountIfMissing(
      transport,
      createNoopSigner(payer.address),
      view.fee_recipient,
      t.mint,
      t.token_program,
    );
    instructions.push(...create);
  }
  const prepared = preparedView(await prepare(transport, instructions, payer.address));
  return finish(
    transport,
    {
      ...view,
      summary: absent.map(
        (t) => `Creates the treasury's account ${t.account} for ${t.mint}, so fills can pay protocol fees in it (${payer.address} pays its rent)`,
      ),
      prepared,
    },
    payer,
    yes,
  );
}
