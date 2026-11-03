import { type Address, getAddressDecoder, type Instruction, type TransactionSigner } from "@solana/kit";
import { InvalidInput, splitFees } from "@intent-engine/core";
import { splitPayout } from "@intent-engine/core/internal";
import { loadConfig, mintOf } from "./accounts.js";
import type { ClientContext } from "./client-types.js";
import { tokenAccountIfMissing } from "./setup.js";
import type { AccountView, Transport } from "./transport.js";

const TOKEN_ACCOUNT_LEN = 165;
const STATE_AT = 108;
const INITIALIZED = 1;
const FROZEN = 2;
const ACCOUNT_TYPE = 2;
const IMMUTABLE_OWNER = 7;
const MEMO_TRANSFER = 8;
const CPI_GUARD = 11;
const STRICT: ReadonlySet<number> = new Set([IMMUTABLE_OWNER]);
const PAYOUT: ReadonlySet<number> = new Set([IMMUTABLE_OWNER, MEMO_TRANSFER, CPI_GUARD]);

export type ReceiveRule = "strict" | "payout";

export type ReceiveRefusal = "not-a-token-account" | "other-mint" | "other-owner" | "not-initialized" | "frozen" | "memo-required" | "extension";

export type ReleaseReads = Pick<ClientContext, "transport" | "mint" | "config">;

export type FeeRole = "protocol" | "partner" | "judge";

export type FeeLeg = { role: FeeRole; wallet: Address; account: Address; amount: bigint; paid: boolean; refused: ReceiveRefusal | null; create: Instruction[] };

export type PayeeLeg = { wallet: Address; account: Address; amount: bigint; accepts: boolean; create: Instruction[] };

export type ReleaseEscrow = {
  owner: Address;
  inputMint: Address;
  escrowed: bigint;
  filled: bigint;
  feeBps: number;
  partnerBps: number;
  partnerCutBps: number;
  partner: Address;
};

export type ReleasePreviewInput = {
  payer: TransactionSigner;
  escrow: ReleaseEscrow;
  tokenProgram: Address;
  judgeFee: bigint;
  judge: Address;
  feeRecipient: Address;
  payees: readonly { wallet: Address; weight: number }[];
};

export type ReleasePreview = {
  amountIn: bigint;
  maxFeeBps: number;
  judgeFee: bigint;
  net: bigint;
  payees: PayeeLeg[];
  fees: FeeLeg[];
  fee: bigint;
  withheld: bigint;
  returnsTo: Address;
  setup: Instruction[];
};

export function releaseReads(transport: Transport): ReleaseReads {
  return {
    transport,
    mint: async (address) => {
      const { decimals, tokenProgram } = await mintOf(transport, address);
      return { decimals, tokenProgram };
    },
    config: async () => (await loadConfig(transport)).config,
  };
}

function extensionRefusal(data: Uint8Array, rule: ReceiveRule): ReceiveRefusal | null {
  if (data.length === TOKEN_ACCOUNT_LEN) {
    return null;
  }
  if (data[TOKEN_ACCOUNT_LEN] !== ACCOUNT_TYPE) {
    return "not-a-token-account";
  }
  const tlv = new DataView(data.buffer, data.byteOffset, data.length);
  for (let at = TOKEN_ACCOUNT_LEN + 1; at + 4 <= data.length; ) {
    const type = tlv.getUint16(at, true);
    const len = tlv.getUint16(at + 2, true);
    if (type === 0) {
      return null;
    }
    if (at + 4 + len > data.length) {
      return "not-a-token-account";
    }
    if (!(rule === "strict" ? STRICT : PAYOUT).has(type)) {
      return "extension";
    }
    if (type === MEMO_TRANSFER && data[at + 4] !== 0) {
      return "memo-required";
    }
    at += 4 + len;
  }
  return null;
}

export function receiveRefusal(view: AccountView | null, tokenProgram: Address, mint: Address, wallet: Address, rule: ReceiveRule): ReceiveRefusal | null {
  if (view === null || view.owner !== tokenProgram || view.data.length < TOKEN_ACCOUNT_LEN) {
    return "not-a-token-account";
  }
  const decoder = getAddressDecoder();
  if (decoder.decode(view.data.subarray(0, 32)) !== mint) {
    return "other-mint";
  }
  if (decoder.decode(view.data.subarray(32, 64)) !== wallet) {
    return "other-owner";
  }
  if (view.data[STATE_AT] === FROZEN) {
    return "frozen";
  }
  if (view.data[STATE_AT] !== INITIALIZED) {
    return "not-initialized";
  }
  return extensionRefusal(view.data, rule);
}

export const canReceive = (view: AccountView | null, tokenProgram: Address, mint: Address, wallet: Address): boolean =>
  receiveRefusal(view, tokenProgram, mint, wallet, "strict") === null;

const holderOf = (view: AccountView | null, fallback: Address): Address =>
  view === null || view.data.length < 64 ? fallback : getAddressDecoder().decode(view.data.subarray(32, 64));

async function landing(transport: Transport, input: ReleasePreviewInput, wallet: Address, rule: ReceiveRule, ownHolder: boolean) {
  const { address, create } = await tokenAccountIfMissing(transport, input.payer, wallet, input.escrow.inputMint, input.tokenProgram);
  if (create.length > 0) {
    return { account: address, create, refused: null };
  }
  const view = await transport.getAccount(address);
  const payee = ownHolder ? holderOf(view, wallet) : wallet;
  return { account: address, create, refused: receiveRefusal(view, input.tokenProgram, input.escrow.inputMint, payee, rule) };
}

async function feeLeg(transport: Transport, input: ReleasePreviewInput, role: FeeRole, wallet: Address, amount: bigint): Promise<FeeLeg> {
  const protocol = role === "protocol";
  const { account, create, refused } = await landing(transport, input, wallet, protocol ? "payout" : "strict", protocol);
  return { role, wallet, account, amount, paid: refused === null, refused, create };
}

export async function releasePreview(transport: Transport, input: ReleasePreviewInput): Promise<ReleasePreview> {
  const { escrow, judgeFee } = input;
  const amountIn = escrow.escrowed - escrow.filled;
  const shares = splitFees(amountIn - judgeFee, escrow.feeBps, escrow.partnerBps, escrow.partnerCutBps);
  const amounts = splitPayout(shares.net, input.payees.map(({ weight }) => weight));
  const owed: [FeeRole, Address, bigint][] = [
    ["protocol", input.feeRecipient, shares.protocol],
    ["partner", escrow.partner, shares.partner],
    ["judge", input.judge, judgeFee],
  ];
  const [payees, fees] = await Promise.all([
    Promise.all(
      input.payees.map(async ({ wallet }, i): Promise<PayeeLeg> => {
        const { account, create, refused } = await landing(transport, input, wallet, "payout", false);
        return { wallet, account, amount: amounts[i] ?? 0n, accepts: refused === null, create };
      }),
    ),
    Promise.all(owed.filter(([, , amount]) => amount > 0n).map(([role, wallet, amount]) => feeLeg(transport, input, role, wallet, amount))),
  ]);
  const total = (legs: FeeLeg[]) => legs.reduce((sum, leg) => sum + leg.amount, 0n);
  return {
    amountIn,
    maxFeeBps: escrow.feeBps + escrow.partnerBps,
    judgeFee,
    net: shares.net,
    payees,
    fees,
    fee: total(fees.filter((leg) => leg.paid)),
    withheld: total(fees.filter((leg) => !leg.paid)),
    returnsTo: escrow.owner,
    setup: [...payees.flatMap(({ create }) => create), ...fees.flatMap(({ create }) => create)],
  };
}

export function solePayee(preview: ReleasePreview): PayeeLeg {
  const [payee, ...others] = preview.payees;
  if (payee === undefined || others.length > 0) {
    throw new InvalidInput("payees", "range", "a single release pays exactly one payee");
  }
  return payee;
}

export const feeLegOf = (preview: ReleasePreview, role: FeeRole): FeeLeg | undefined => preview.fees.find((leg) => leg.role === role);

export function feeAccounts(preview: ReleasePreview): { feeRecipient?: Address; partner?: Address; judge?: Address } {
  const feeRecipient = feeLegOf(preview, "protocol")?.wallet;
  const partner = feeLegOf(preview, "partner")?.wallet;
  const judge = feeLegOf(preview, "judge")?.wallet;
  return {
    ...(feeRecipient === undefined ? {} : { feeRecipient }),
    ...(partner === undefined ? {} : { partner }),
    ...(judge === undefined ? {} : { judge }),
  };
}
