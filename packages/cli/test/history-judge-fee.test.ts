import { type Address, generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { formatAmount, NATIVE_MINT } from "@intent-engine/core";
import { getFeeWithheldEventEncoder, getIntentAttestedEventEncoder, getIntentSplitEventEncoder, sortMembers } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { profitOf } from "../src/agent/wallet/history-profit.js";
import { preset } from "./agent-wallet-kit.js";
import { funded, h, transport, world } from "./harness.js";
import { attestedEvent, createdEvent, landed, tagged } from "./kill-cli-wallet-survivors-kit.js";

const JOB_NET = 10_000n;
const NET = 500n;
const PROTOCOL = 30n;
const PARTNER = 20n;
const JUDGE_FEE = 7n;
const WITHHELD_JUDGE = 4;
const WITHHELD_PROTOCOL = 5;

const newAddress = async (): Promise<Address> => (await generateKeyPairSigner()).address;

type Paid = { attestor: Address; fee?: bigint; split?: boolean };

function releaseEvent(intent: Address, owner: Address, payee: Address, paid: Paid, judgeFee: bigint, withheld: bigint) {
  const fee = paid.fee ?? PROTOCOL;
  const amountIn = NET + fee + PARTNER + judgeFee + withheld;
  if (paid.split === true) {
    return tagged(getIntentSplitEventEncoder().encode({ intent, owner, solver: owner, attestor: paid.attestor, amountIn, result: 1n, fee, net: NET, partnerFee: PARTNER, recipients: 1, splitHash: new Uint8Array(32) }));
  }
  return tagged(getIntentAttestedEventEncoder().encode({ intent, owner, solver: owner, payee, attestor: paid.attestor, amountIn, result: 1n, fee, net: NET, filled: amountIn, remaining: 0n, partnerFee: PARTNER }));
}

const withheldEvent = (intent: Address, payee: Address, fee: bigint, role: number) => tagged(getFeeWithheldEventEncoder().encode({ intent, payee, account: payee, fee, role }));

type Setup = { wallet: Address; judge: (wallet: Address) => Promise<Address>; withheld?: { fee: bigint; role: number }; fee?: bigint; split?: boolean };

async function profit(setup: Setup) {
  await world();
  preset(NATIVE_MINT);
  const { wallet } = setup;
  const [job, spent, other, jobPayee, payee] = [await newAddress(), await newAddress(), await newAddress(), await newAddress(), await newAddress()];
  const attestor = await setup.judge(wallet);
  const withheld = setup.withheld === undefined ? [] : [withheldEvent(spent, attestor, setup.withheld.fee, setup.withheld.role)];
  const judgeFee = setup.withheld?.role === WITHHELD_JUDGE ? 0n : JUDGE_FEE;
  const release = releaseEvent(spent, wallet, payee, { attestor, ...(setup.fee === undefined ? {} : { fee: setup.fee }), ...(setup.split === undefined ? {} : { split: setup.split }) }, judgeFee, setup.withheld?.fee ?? 0n);
  h.engineLog = [
    landed("job", 30n, [attestedEvent(job, other, jobPayee, JOB_NET, 0n, 0n)], { tokens: [{ account: jobPayee, mint: NATIVE_MINT, owner: wallet }] }),
    landed("paid", 20n, [...withheld, release], { feePayer: other, tokens: [{ account: payee, mint: NATIVE_MINT, owner: other }] }),
    landed("made", 10n, [createdEvent(spent, wallet, 0)], { feePayer: other }),
  ];
  return profitOf(transport, wallet, job, [spent]);
}

const shown = (fees: bigint) => ({
  received: formatAmount(JOB_NET, 9),
  paid_out: formatAmount(NET, 9),
  fees: formatAmount(fees, 9),
  fees_sol: "0",
  rent_sol: "0",
  difference: formatAmount(JOB_NET - NET - fees, 9),
});

const elsewhere = async () => newAddress();
const itself = async (wallet: Address) => wallet;

async function committeePaying(feeWallet: (wallet: Address) => Promise<Address>) {
  return async (wallet: Address): Promise<Address> => {
    const members = sortMembers([await newAddress(), await newAddress()]);
    const made = await createClient({ url: "http://cluster", transport }).createCommittee({ members, threshold: 1, feeWallet: await feeWallet(wallet), payer: await funded() });
    return made.committee;
  };
}

describe("the fees a paid_from escrow cost, judge fee included", () => {
  it("adds a judge fee paid to another judge to fees and takes it off difference", async () => {
    const wallet = await newAddress();
    expect(await profit({ wallet, judge: elsewhere })).toMatchObject(shown(PROTOCOL + PARTNER + JUDGE_FEE));
  });

  it("adds a judge fee a split release paid to another judge", async () => {
    const wallet = await newAddress();
    expect(await profit({ wallet, judge: elsewhere, split: true })).toMatchObject(shown(PROTOCOL + PARTNER + JUDGE_FEE));
  });

  it("adds no judge fee this wallet paid to itself as the judge", async () => {
    const wallet = await newAddress();
    expect(await profit({ wallet, judge: itself })).toMatchObject(shown(PROTOCOL + PARTNER));
  });

  it("adds the judge fee of a committee whose fee wallet is another wallet, and not of one whose fee wallet is this one", async () => {
    const wallet = await newAddress();
    expect(await profit({ wallet, judge: await committeePaying(elsewhere) })).toMatchObject(shown(PROTOCOL + PARTNER + JUDGE_FEE));
    expect(await profit({ wallet, judge: await committeePaying(itself) })).toMatchObject(shown(PROTOCOL + PARTNER));
  });

  it("adds no judge fee the release withheld, since it stays with the escrow's owner", async () => {
    const wallet = await newAddress();
    expect(await profit({ wallet, judge: elsewhere, withheld: { fee: JUDGE_FEE, role: WITHHELD_JUDGE } })).toMatchObject(shown(PROTOCOL + PARTNER));
  });

  it("counts a withheld protocol fee as neither protocol nor judge fee", async () => {
    const wallet = await newAddress();
    expect(await profit({ wallet, judge: elsewhere, fee: 0n, withheld: { fee: PROTOCOL, role: WITHHELD_PROTOCOL } })).toMatchObject(shown(PARTNER + JUDGE_FEE));
  });
});
