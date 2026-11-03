import { type Address, AccountRole, generateKeyPairSigner, getBase16Decoder, getBase16Encoder, getBase58Decoder, type Instruction, type KeyPairSigner, signBytes } from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  AuthorityType,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getFreezeAccountInstruction,
  getInitializeMint2Instruction,
  getMintToInstruction,
  getSetAuthorityInstruction,
} from "@solana-program/token";
import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, findAssociatedTokenAddress, formatAmount, Kind, NATIVE_MINT, splitFees, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { findIntentPda, TOKEN_2022_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { svmTransport } from "@intent-engine/client/svm";
import { planRelease, releaseReads, SYSTEM_PROGRAM_ADDRESS } from "@intent-engine/client/internal";
import { connect, type Json, ok, preset } from "./agent-wallet-kit.js";
import { announced, keyed } from "./announce.js";
import { ata22, keyOf } from "./held-kit.js";
import { ata, balance, DOMAIN, FEE_BPS, funded, h, mint as plainMint, send, world } from "./harness.js";

const WORK = "6c".repeat(32);
const PAY = 1_000_000n;
const JUDGE_FEE = 10_000n;
const PARTNER_BPS = 50;
const MINT_LEN = 82n;
const T22 = { programAddress: TOKEN_2022_PROGRAM_ADDRESS };
const SHARES = splitFees(PAY - JUDGE_FEE, FEE_BPS, PARTNER_BPS, 0);
const whole = (raw: bigint) => formatAmount(raw, 6);

type Role = "judge" | "partner";
type Block = (payer: KeyPairSigner, mint: Address, owner: KeyPairSigner) => Promise<void>;

async function opened(payer: KeyPairSigner, mint: Address, owner: Address): Promise<Address> {
  await send(payer, [await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })]);
  return ata22(owner, mint);
}

const guard: Block = async (payer, mint, owner) => {
  const account = await opened(payer, mint, owner.address);
  const signerMeta = (signer: KeyPairSigner, role: AccountRole) => ({ address: signer.address, role, signer });
  const reallocate: Instruction = {
    programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    accounts: [{ address: account, role: AccountRole.WRITABLE }, signerMeta(payer, AccountRole.WRITABLE_SIGNER), { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY }, signerMeta(owner, AccountRole.READONLY_SIGNER)],
    data: Uint8Array.of(29, 11, 0),
  };
  const enable: Instruction = {
    programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    accounts: [{ address: account, role: AccountRole.WRITABLE }, signerMeta(owner, AccountRole.READONLY_SIGNER)],
    data: Uint8Array.of(34, 0),
  };
  await send(payer, [reallocate, enable]);
};

const freeze: Block = async (payer, mint, owner) => {
  const account = await opened(payer, mint, owner.address);
  await send(payer, [getFreezeAccountInstruction({ account, mint, owner: payer }, T22)]);
};

const reassigned: Block = async (payer, mint, owner) => {
  const account = await ata(payer, owner.address, mint);
  const other = await generateKeyPairSigner();
  await send(payer, [getSetAuthorityInstruction({ owned: account, owner, authorityType: AuthorityType.AccountOwner, newAuthority: other.address })]);
};

async function job(blocks: Partial<Record<Role, Block>> = {}, spl = false) {
  await world();
  const through = svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) });
  h.through = through;
  preset(NATIVE_MINT);
  preset(DEVNET_TEST_MINT);
  const client: Client = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
  const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
  const judge = await keyOf(wallet);
  const payer = await funded();
  const owner = await funded();
  let mint: Address;
  if (spl) {
    mint = await plainMint(payer);
    await ata(payer, owner.address, mint, PAY);
  } else {
    const created = await generateKeyPairSigner();
    await send(payer, [
      getCreateAccountInstruction({ payer, newAccount: created, lamports: h.svm.minimumBalanceForRentExemption(MINT_LEN), space: MINT_LEN, programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
      getInitializeMint2Instruction({ mint: created.address, decimals: 6, mintAuthority: payer.address, freezeAuthority: payer.address }, T22),
    ]);
    mint = created.address;
    await send(payer, [getMintToInstruction({ mint, token: await opened(payer, mint, owner.address), mintAuthority: payer, amount: PAY }, T22)]);
  }
  const partner = await keyed();
  const engine = createClient({ url: "http://cluster", transport: through });
  const { nonce } = await engine.createIntent({
    signer: owner,
    params: { kind: Kind.AttestedResult, amountIn: PAY, minResult: 1n, maxResult: 1n, attestor: wallet, specHash: Uint8Array.from(Buffer.from(WORK, "hex")), judgeFee: JUDGE_FEE },
    inputMint: mint,
    outputMint: await plainMint(payer),
    partner: partner.address,
    partnerBps: PARTNER_BPS,
  });
  const [intent] = await findIntentPda({ owner: owner.address, nonce });
  const coauthor = await keyed();
  const made = await announced(intent, coauthor, WORK, undefined, through);
  for (const [role, who] of [
    ["judge", judge],
    ["partner", partner],
  ] as const) {
    await blocks[role]?.(payer, mint, who);
  }
  const release = { owner: owner.address, nonce: String(nonce), delivered_sha256: WORK };
  const split = { ...release, recipients: [{ wallet: coauthor.address, weight: 10_000 }] };
  const target = { intent: { owner: owner.address, nonce }, announcement: made.announcement, opening: { sha256: WORK, salt: made.salt }, result: 1n, payer: judge };
  const client22 = async () => (await planRelease(releaseReads(through), target, async (attestor) => ({ feeOwner: attestor, judge: attestor }))).preview;
  const signedSplit = async (shown: Json) => {
    const envelope = Uint8Array.from(getBase16Encoder().encode(String(shown["envelope"])));
    const signature = getBase16Decoder().decode(new Uint8Array(await signBytes(coauthor.keyPair.privateKey, envelope)));
    return { ...release, recipients: [{ wallet: coauthor.address, weight: 10_000, signature }], approval: shown["approval"], send: true };
  };
  return { client, wallet, partner: partner.address, owner: owner.address, mint, release, split, client22, signedSplit };
}

const AMOUNT: Record<Role, bigint> = { judge: JUDGE_FEE, partner: SHARES.partner };
const PAYS: Record<Role, string> = { judge: "Pays the judge", partner: "Pays the partner" };
const legOf = (shown: Json, role: string) => (shown["fees"] as Json[]).find((leg) => leg["role"] === role);
const lines = (shown: Json) => shown["summary"] as string[];

describe("release previews of a fee the program pays", () => {
  it("say the judge and partner fees are paid into normal accounts", async () => {
    const s = await job();
    for (const shown of [await ok(s.client, "wallet_attest", s.release), await ok(s.client, "wallet_attest_split", s.split)]) {
      expect(lines(shown)).toContainEqual(`Pays the judge: ${whole(JUDGE_FEE)} of ${s.mint} to this wallet, carved out of the escrow`);
      expect(lines(shown)).toContainEqual(`Pays the partner: ${whole(SHARES.partner)} of ${s.mint} to ${s.partner}`);
      expect(lines(shown).filter((line) => line.startsWith("Withholds"))).toEqual([]);
      expect(shown).toMatchObject({ fee: whole(SHARES.protocol + SHARES.partner + JUDGE_FEE), withheld: "0" });
      expect((shown["fees"] as Json[]).map((leg) => [leg["role"], leg["paid"]])).toEqual([
        ["protocol", true],
        ["partner", true],
        ["judge", true],
      ]);
    }
  });
});

describe("release previews of a fee the program withholds", () => {
  for (const role of ["judge", "partner"] as const) {
    for (const [what, block, reason] of [
      ["has a CPI guard", guard, "carries a token extension other than ImmutableOwner, such as a CPI guard"],
      ["is frozen", freeze, "is frozen"],
    ] as const) {
      it(`list the ${role} fee as withheld when its account ${what}`, async () => {
        const s = await job({ [role]: block });
        const holder = role === "judge" ? s.wallet : s.partner;
        for (const shown of [await ok(s.client, "wallet_attest", s.release), await ok(s.client, "wallet_attest_split", s.split)]) {
          expect(lines(shown).filter((line) => line.startsWith(PAYS[role]))).toEqual([]);
          expect(lines(shown)).toContainEqual(
            `Withholds the ${role} fee: ${whole(AMOUNT[role])} of ${s.mint} is not paid to the ${role} ${holder}, whose account ${await ata22(holder, s.mint)} ${reason}; it stays in the escrow and goes to its owner ${s.owner} when it closes`,
          );
          expect(legOf(shown, role)).toEqual({ role, wallet: holder, account: await ata22(holder, s.mint), amount: whole(AMOUNT[role]), paid: false });
          expect(shown).toMatchObject({ fee: whole(SHARES.protocol + SHARES.partner + JUDGE_FEE - AMOUNT[role]), withheld: whole(AMOUNT[role]) });
        }
      });
    }
  }

  it("is true to the send: a judge fee into a CPI-guarded account is withheld by the program", async () => {
    const s = await job({ judge: guard });
    const shown = await ok(s.client, "wallet_attest_split", s.split);
    expect(await ok(s.client, "wallet_attest_split", await s.signedSplit(shown))).toMatchObject({ sent: true });
    expect(balance(await ata22(s.wallet, s.mint))).toBe(0n);
    expect(balance(await ata22(s.partner, s.mint))).toBe(SHARES.partner);
  });

  it("is true to the send of a single release too", async () => {
    const s = await job({ partner: freeze });
    const shown = await ok(s.client, "wallet_attest", s.release);
    expect(await ok(s.client, "wallet_attest", { ...s.release, approval: shown["approval"], send: true })).toMatchObject({ sent: true });
    expect(balance(await ata22(s.partner, s.mint))).toBe(0n);
    expect(balance(await ata22(s.wallet, s.mint))).toBe(JUDGE_FEE);
  });
});

describe("the reason a release preview gives for a withheld fee", () => {
  it("says an SPL judge account given to another owner now belongs to another owner, not that it is frozen", async () => {
    const s = await job({ judge: reassigned }, true);
    const account = await findAssociatedTokenAddress({ owner: s.wallet, mint: s.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const expected = `Withholds the judge fee: ${whole(JUDGE_FEE)} of ${s.mint} is not paid to the judge ${s.wallet}, whose account ${account} now belongs to another owner; it stays in the escrow and goes to its owner ${s.owner} when it closes`;
    for (const shown of [await ok(s.client, "wallet_attest", s.release), await ok(s.client, "wallet_attest_split", s.split)]) {
      expect(lines(shown)).toContainEqual(expected);
      expect(lines(shown).filter((line) => line.startsWith("Pays the judge"))).toEqual([]);
    }
    const shown = await ok(s.client, "wallet_attest", s.release);
    expect(await ok(s.client, "wallet_attest", { ...s.release, approval: shown["approval"], send: true })).toMatchObject({ sent: true });
    expect(balance(account)).toBe(0n);
  });
});

describe("the three release previews", () => {
  it("give identical figures for one escrow", async () => {
    const s = await job({ judge: guard });
    const single = await ok(s.client, "wallet_attest", s.release);
    const split = await ok(s.client, "wallet_attest_split", s.split);
    const sdk = await s.client22();
    const figures = (paid: unknown, shown: Json) => ({ paid, fee: shown["fee"], withheld: shown["withheld"], fees: shown["fees"] });
    const fromSdk = {
      paid: whole(sdk.payees[0]?.amount ?? -1n),
      fee: whole(sdk.fee),
      withheld: whole(sdk.withheld),
      fees: sdk.fees.map((leg) => ({ role: leg.role, wallet: leg.wallet, account: leg.account, amount: whole(leg.amount), paid: leg.paid })),
    };
    expect(figures(single["paid"], single)).toEqual(fromSdk);
    expect(figures((split["paid"] as Json[])[0]?.["amount"], split)).toEqual(fromSdk);
    expect(split["net"]).toBe(fromSdk.paid);
    expect(fromSdk).toMatchObject({ paid: whole(SHARES.net), withheld: whole(JUDGE_FEE) });
  });
});
