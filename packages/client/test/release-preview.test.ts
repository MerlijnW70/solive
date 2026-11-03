import { type Address, AccountRole, generateKeyPairSigner, type Instruction, type KeyPairSigner } from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import { AuthorityType, getFreezeAccountInstruction, getInitializeMint2Instruction, getSetAuthorityInstruction } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, Kind, splitFees, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { findIntentPda, TOKEN_2022_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { SYSTEM_PROGRAM_ADDRESS } from "../src/accounts.js";
import { createClient } from "../src/index.js";
import { splitPreview } from "../src/client-split.js";
import { planRelease } from "../src/release-plan.js";
import { canReceive, type FeeRole, receiveRefusal, releaseReads } from "../src/release-preview.js";
import { FEE_BPS, world, type World } from "./svm.js";
import { ata22, balance22, tokens22 } from "./token22.js";
import { announced, fundedSigner, LOCAL, sha, specHash } from "./work.js";

const PAY = 1_000_000n;
const JUDGE_FEE = 10_000n;
const PARTNER_BPS = 50;
const MINT_LEN = 82n;
const REALLOCATE = 29;
const CPI_GUARD_EXTENSION = 11;
const CPI_GUARD = 34;
const ENABLE = 0;
const T22 = { programAddress: TOKEN_2022_PROGRAM_ADDRESS };

async function freezableMint(w: World): Promise<Address> {
  const created = await generateKeyPairSigner();
  await w.chain.transport.send(
    [
      getCreateAccountInstruction({ payer: w.authority, newAccount: created, lamports: w.chain.svm.minimumBalanceForRentExemption(MINT_LEN), space: MINT_LEN, programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
      getInitializeMint2Instruction({ mint: created.address, decimals: 6, mintAuthority: w.authority.address, freezeAuthority: w.authority.address }, T22),
    ],
    w.authority,
  );
  return created.address;
}

async function cpiGuarded(w: World, owner: KeyPairSigner, account: Address): Promise<void> {
  const reallocate: Instruction = {
    programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    accounts: [
      { address: account, role: AccountRole.WRITABLE },
      { address: w.authority.address, role: AccountRole.WRITABLE_SIGNER, signer: w.authority },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: owner.address, role: AccountRole.READONLY_SIGNER, signer: owner },
    ] as NonNullable<Instruction["accounts"]>,
    data: Uint8Array.of(REALLOCATE, CPI_GUARD_EXTENSION, 0),
  };
  const enable: Instruction = {
    programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    accounts: [
      { address: account, role: AccountRole.WRITABLE },
      { address: owner.address, role: AccountRole.READONLY_SIGNER, signer: owner },
    ] as NonNullable<Instruction["accounts"]>,
    data: Uint8Array.of(CPI_GUARD, ENABLE),
  };
  await w.chain.transport.send([reallocate, enable], w.authority);
}

async function frozen(w: World, mint: Address, account: Address): Promise<void> {
  await w.chain.transport.send([getFreezeAccountInstruction({ account, mint, owner: w.authority }, T22)], w.authority);
}

type Block = (w: World, mint: Address, owner: KeyPairSigner) => Promise<void>;

const guard: Block = async (w, mint, owner) => cpiGuarded(w, owner, await tokens22(w, owner.address, mint, 0n));
const freeze: Block = async (w, mint, owner) => frozen(w, mint, await tokens22(w, owner.address, mint, 0n));
const plain: Block = async (w, mint, owner) => {
  await tokens22(w, owner.address, mint, 0n);
};
const plainSpl: Block = async (w, mint, owner) => {
  await w.test.tokens(owner.address, mint, 0n);
};
const reassigned: Block = async (w, mint, owner) => {
  const account = await w.test.tokens(owner.address, mint, 0n);
  const other = await generateKeyPairSigner();
  await w.chain.transport.send([getSetAuthorityInstruction({ owned: account, owner, authorityType: AuthorityType.AccountOwner, newAuthority: other.address })], w.authority);
};

async function escrow(blocks: Partial<Record<"judge" | "partner" | "treasury", Block>> = {}, spl = false) {
  const w = await world();
  const client = createClient({ url: LOCAL, transport: w.chain.transport });
  const mint = spl ? await w.test.mint(6) : await freezableMint(w);
  const program = spl ? TOKEN_PROGRAM_ADDRESS : TOKEN_2022_PROGRAM_ADDRESS;
  const ataOf = (wallet: Address) => findAssociatedTokenAddress({ owner: wallet, mint, tokenProgram: program });
  const opened = spl ? plainSpl : plain;
  await (spl ? w.test.tokens(w.owner.address, mint, PAY) : tokens22(w, w.owner.address, mint, PAY));
  const [worker, judge, partner] = await Promise.all([fundedSigner(w), fundedSigner(w), fundedSigner(w)]);
  const { nonce } = await client.createIntent({
    signer: w.owner,
    params: { kind: Kind.AttestedResult, amountIn: PAY, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: specHash("preview"), judgeFee: JUDGE_FEE },
    inputMint: mint,
    outputMint: w.outputMint,
    partner: partner.address,
    partnerBps: PARTNER_BPS,
  });
  const [intent] = await findIntentPda({ owner: w.owner.address, nonce });
  const delivered = await announced(client, worker, intent, sha("preview"));
  await (blocks.judge ?? opened)(w, mint, judge);
  await (blocks.partner ?? opened)(w, mint, partner);
  await (blocks.treasury ?? opened)(w, mint, w.feeRecipient);
  const target = { intent: { owner: w.owner.address, nonce }, ...delivered, result: 1n };
  const reads = releaseReads(w.chain.transport);
  const single = async () => (await planRelease(reads, { ...target, payer: judge }, async (attestor) => ({ feeOwner: attestor, judge: attestor }))).preview;
  const split = async () => (await splitPreview(reads, { ...target, recipients: [{ wallet: worker.address, weight: 10_000 }] }, judge)).preview;
  const settle = () => client.settleProof({ ...target, judge });
  const held = async (wallet: Address) => balance22(w, await ataOf(wallet));
  return { w, mint, worker, judge, partner, single, split, settle, held, ataOf };
}

const shares = splitFees(PAY - JUDGE_FEE, FEE_BPS, PARTNER_BPS, 0);
const legOf = (preview: { fees: { role: FeeRole; paid: boolean; amount: bigint; refused: string | null }[] }, role: FeeRole) => preview.fees.find((leg) => leg.role === role);

describe("a release preview against the program's receive rule", () => {
  it("shows every fee paid into normal accounts, and the program pays them", async () => {
    const s = await escrow();
    const preview = await s.single();
    expect(preview.fees.map(({ role, amount, paid }) => ({ role, amount, paid }))).toEqual([
      { role: "protocol", amount: shares.protocol, paid: true },
      { role: "partner", amount: shares.partner, paid: true },
      { role: "judge", amount: JUDGE_FEE, paid: true },
    ]);
    expect([preview.fee, preview.withheld]).toEqual([shares.protocol + shares.partner + JUDGE_FEE, 0n]);
    await s.settle();
    expect([await s.held(s.judge.address), await s.held(s.partner.address), await s.held(s.worker.address)]).toEqual([JUDGE_FEE, shares.partner, shares.net]);
  });

  for (const [what, block] of [
    ["a CPI guard", guard],
    ["a frozen account", freeze],
  ] as const) {
    it(`lists the judge fee as withheld for ${what}, and the program withholds it`, async () => {
      const s = await escrow({ judge: block });
      for (const preview of [await s.single(), await s.split()]) {
        expect(legOf(preview, "judge")).toMatchObject({ wallet: s.judge.address, account: await ata22(s.judge.address, s.mint), amount: JUDGE_FEE, paid: false, create: [] });
        expect(legOf(preview, "partner")?.paid).toBe(true);
        expect([preview.fee, preview.withheld, preview.returnsTo]).toEqual([shares.protocol + shares.partner, JUDGE_FEE, s.w.owner.address]);
      }
      await s.settle();
      expect(await s.held(s.judge.address)).toBe(0n);
      expect(await s.held(s.partner.address)).toBe(shares.partner);
    });

    it(`lists the partner fee as withheld for ${what}, and the program withholds it`, async () => {
      const s = await escrow({ partner: block });
      for (const preview of [await s.single(), await s.split()]) {
        expect(legOf(preview, "partner")).toMatchObject({ wallet: s.partner.address, amount: shares.partner, paid: false });
        expect(legOf(preview, "judge")?.paid).toBe(true);
        expect([preview.fee, preview.withheld]).toEqual([shares.protocol + JUDGE_FEE, shares.partner]);
      }
      await s.settle();
      expect(await s.held(s.partner.address)).toBe(0n);
      expect(await s.held(s.judge.address)).toBe(JUDGE_FEE);
    });
  }

  it("keeps the protocol leg on the looser rule: a treasury account with a CPI guard is still paid", async () => {
    const s = await escrow({ treasury: guard });
    const preview = await s.single();
    expect(legOf(preview, "protocol")).toMatchObject({ amount: shares.protocol, paid: true });
    await s.settle();
    expect(await s.held(s.w.feeRecipient.address)).toBe(shares.protocol);
  });

  it("gives the single and the split release the same figures for one escrow", async () => {
    const s = await escrow({ judge: guard });
    const [single, split] = [await s.single(), await s.split()];
    const figures = (p: typeof single) => ({ amountIn: p.amountIn, net: p.net, fee: p.fee, withheld: p.withheld, fees: p.fees.map(({ role, account, amount, paid }) => ({ role, account, amount, paid })), paid: p.payees.map(({ account, amount }) => ({ account, amount })) });
    expect(figures(split)).toEqual(figures(single));
  });

  it("checks the treasury account against its own owner, as the program does: a reassigned SPL treasury account is still paid", async () => {
    const s = await escrow({ treasury: reassigned }, true);
    const preview = await s.single();
    expect(legOf(preview, "protocol")).toMatchObject({ wallet: s.w.feeRecipient.address, account: await s.ataOf(s.w.feeRecipient.address), paid: true, refused: null });
    await s.settle();
    expect(await s.held(s.w.feeRecipient.address)).toBe(shares.protocol);
  });

  it("names why each fee is withheld: an SPL judge account given to another owner, a frozen one, one with a CPI guard", async () => {
    const moved = await escrow({ judge: reassigned }, true);
    expect(legOf(await moved.single(), "judge")).toMatchObject({ paid: false, refused: "other-owner" });
    await moved.settle();
    expect(await moved.held(moved.judge.address)).toBe(0n);
    expect(legOf(await (await escrow({ judge: freeze })).single(), "judge")).toMatchObject({ paid: false, refused: "frozen" });
    expect(legOf(await (await escrow({ judge: guard })).single(), "judge")).toMatchObject({ paid: false, refused: "extension" });
  });

  it("refuses no account the program would take and takes none it would refuse", async () => {
    const s = await escrow({ judge: guard, partner: freeze });
    const program = TOKEN_2022_PROGRAM_ADDRESS;
    const view = async (wallet: Address) => s.w.chain.transport.getAccount(await ata22(wallet, s.mint));
    expect(canReceive(await view(s.judge.address), program, s.mint, s.judge.address)).toBe(false);
    expect(canReceive(await view(s.partner.address), program, s.mint, s.partner.address)).toBe(false);
    expect(canReceive(await view(s.w.feeRecipient.address), program, s.mint, s.w.feeRecipient.address)).toBe(true);
    expect(canReceive(await view(s.w.feeRecipient.address), program, s.mint, s.judge.address)).toBe(false);
    expect(canReceive(null, program, s.mint, s.judge.address)).toBe(false);
    const other = await freezableMint(s.w);
    expect(receiveRefusal(await view(s.w.feeRecipient.address), program, other, s.w.feeRecipient.address, "strict")).toBe("other-mint");
    expect(receiveRefusal(await view(s.w.feeRecipient.address), program, s.mint, s.judge.address, "strict")).toBe("other-owner");
    expect(receiveRefusal(await view(s.w.feeRecipient.address), TOKEN_PROGRAM_ADDRESS, s.mint, s.w.feeRecipient.address, "strict")).toBe("not-a-token-account");
    expect(receiveRefusal(await view(s.judge.address), program, s.mint, s.judge.address, "payout")).toBeNull();
    expect(receiveRefusal(await view(s.partner.address), program, s.mint, s.partner.address, "payout")).toBe("frozen");
  });
});
