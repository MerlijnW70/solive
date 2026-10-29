import { type Address, lamports, getBase16Decoder, getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, type Instruction, type KeyPairSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import type { Client } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findAssociatedTokenAddress, formatAmount, Kind, NATIVE_MINT, splitFees } from "@intent-engine/core";
import { getIntentDecoder, signCommitteeVote, sortMembers, splitFee } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { loadConfig } from "@intent-engine/client/internal";
import { WRAPPED } from "../src/agent/create.js";
import { call, closeAccount, connect, fresh, ok } from "./agent-wallet-kit.js";
import { announced, keyed } from "./announce.js";
import { approved } from "./approved.js";
import { keyedProfile } from "./encryption-job.js";
import { ata, cli, FEE_BPS, funded, h, mint, setNow, transport } from "./harness.js";
import { deviceKey } from "./ledger-device.js";
import { freeProtocol } from "./kill-cli-wallet-survivors-kit.js";

const forced = vi.hoisted(() => ({ setup: undefined as unknown }));

vi.mock("@intent-engine/client/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@intent-engine/client/node")>();
  return {
    ...actual,
    createClient: (...args: Parameters<typeof actual.createClient>) => {
      const client = actual.createClient(...args);
      return new Proxy(client, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (key !== "plan") {
            return value;
          }
          return new Proxy(value as object, {
            get(plan, planKey) {
              const method = Reflect.get(plan, planKey) as (...rest: unknown[]) => Promise<object>;
              if (planKey !== "settleCommittee" || forced.setup === undefined) {
                return method;
              }
              return async (...rest: unknown[]) => ({ ...(await method.apply(plan, rest)), setup: forced.setup });
            },
          });
        },
      });
    },
  };
});

const WORK = "e7".repeat(32);

const accountKeys = (wire: string): string[] => {
  const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(getBase64Encoder().encode(wire)).messageBytes);
  return [...message.staticAccounts];
};

const treasuryAccount = async (): Promise<Address> =>
  findAssociatedTokenAddress({ owner: (await loadConfig(transport)).config.feeRecipient, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });

const walletAccount = (wallet: Address): Promise<Address> => findAssociatedTokenAddress({ owner: wallet, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });

async function started(free: boolean) {
  const client = await fresh();
  if (free) {
    await freeProtocol();
  }
  const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
  h.watched.push(wallet);
  h.engineLog = [];
  const escrow = async (terms: Record<string, unknown>) =>
    ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", attestor: wallet, min_result: "1", max_result: "1", ...terms }));
  return { client, wallet, escrow };
}

describe("releasing an escrow as its attestor", () => {
  beforeEach(() => {
    forced.setup = undefined;
  });

  it("refuses at the second the escrow expires and allows the second before", async () => {
    const { client, wallet, escrow } = await started(false);
    const made = await escrow({ amount: "0.05" });
    const worker = await keyed();
    const held = h.svm.getAccount(made["intent"] as Address);
    if (!held.exists) {
      throw new Error("the escrow was not created");
    }
    const { expiresAt } = getIntentDecoder().decode(held.data);
    const release = { owner: wallet, nonce: made["nonce"], pay_to: worker.address };
    setNow(expiresAt - 1n);
    expect(await ok(client, "wallet_attest", release)).toMatchObject({ pay_to: worker.address, sent: false });
    setNow(expiresAt);
    expect((await call(client, "wallet_attest", release)).value).toMatchObject({ code: "IntentExpired" });
  });

  it("asks for the treasury account when a protocol fee is owed", async () => {
    const { client, wallet, escrow } = await started(false);
    const worker = await keyed();
    const large = await escrow({ amount: "0.05" });
    const full = { owner: wallet, nonce: large["nonce"], pay_to: worker.address };
    const shown = await ok(client, "wallet_attest", full);
    expect(shown["fee"]).toBe(formatAmount(splitFee(50_000_000n, FEE_BPS).fee, 9));
    expect(JSON.stringify(shown["summary"])).toContain("engine treasury");
    await ok(client, "wallet_attest", { ...full, approval: shown["approval"], send: true });
    expect(accountKeys(h.wires.at(-1) ?? "")).toContain(await treasuryAccount());
  });

  it("opens no treasury account and names no protocol fee when none is owed", async () => {
    const { client, wallet, escrow } = await started(true);
    const worker = await keyed();
    const made = await escrow({ amount: "0.05" });
    const release = { owner: wallet, nonce: made["nonce"], pay_to: worker.address };
    const shown = await ok(client, "wallet_attest", release);
    expect(shown).toMatchObject({ fee: "0", paid: "0.05" });
    expect(JSON.stringify(shown["summary"])).not.toContain("engine treasury");
    expect(await ok(client, "wallet_attest", { ...release, approval: shown["approval"], send: true })).toMatchObject({ sent: true });
    expect(accountKeys(h.wires.at(-1) ?? "")).not.toContain(await treasuryAccount());
  });

  it("creates the judge's token account only for a judge fee above nothing", async () => {
    const { client, wallet, escrow } = await started(false);
    const worker = await keyed();
    const free = await escrow({ amount: "0.05", spec_hash: "5c".repeat(32) });
    await announced(free["intent"] as Address, worker, WORK);
    const paid = await escrow({ amount: "0.05", spec_hash: "5d".repeat(32), judge_fee: "0.001" });
    await announced(paid["intent"] as Address, worker, WORK);
    closeAccount(await walletAccount(wallet));
    const shown = await ok(client, "wallet_attest", { owner: wallet, nonce: free["nonce"], delivered_sha256: WORK });
    expect(JSON.stringify(shown["summary"])).not.toContain("judge fee");
    const withFee = await ok(client, "wallet_attest", { owner: wallet, nonce: paid["nonce"], delivered_sha256: WORK });
    expect(withFee["summary"]).toContainEqual(expect.stringContaining("Pays the judge: 0.001 of SOL"));
    expect(withFee["summary"]).toContainEqual(expect.stringContaining("Setup: creates this wallet's SOL account for the judge fee"));
  });
});

describe("splitting a release among co-authors with a judge fee", () => {
  async function split(free: boolean, amount: string, judgeFee: string) {
    const { client, wallet, escrow } = await started(free);
    const coauthors = [await keyed(), await keyed()] as [KeyPairSigner, KeyPairSigner];
    const recipients = coauthors.map((c) => ({ wallet: c.address, weight: 5_000 }));
    const made = await escrow({ amount, spec_hash: "61".repeat(32), judge_fee: judgeFee });
    await announced(made["intent"] as Address, coauthors[0], WORK);
    return { wallet, shown: await ok(client, "wallet_attest_split", { owner: wallet, nonce: made["nonce"], recipients, delivered_sha256: WORK }) };
  }

  it("takes the judge fee off before the protocol fee and counts it in the fee shown", async () => {
    const { wallet, shown } = await split(false, "0.05", "0.001");
    const { fee, net } = splitFee(49_000_000n, FEE_BPS);
    expect(shown).toMatchObject({ net: formatAmount(net, 9), fee: formatAmount(fee + 1_000_000n, 9) });
    expect(shown["summary"][0]).toBe(`Splits: ${formatAmount(net, 9)} of SOL among 2 co-authors from ${wallet}'s escrow${WRAPPED}`);
    expect(shown["lookup_accounts"]).toContain(await treasuryAccount());
  });

  it("asks for the partner's account and counts its fee only when a partner fee is owed", async () => {
    const client = await fresh();
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(wallet);
    h.engineLog = [];
    const owner = await funded();
    const token = await mint(owner);
    const other = await mint(owner);
    await ata(owner, owner.address, token, 20_000n);
    await ata(owner, owner.address, other);
    const partner = (await keyed()).address;
    const coauthor = await keyed();
    const recipients = [{ wallet: coauthor.address, weight: 10_000 }];
    const params = { kind: Kind.AttestedResult, amountIn: 10_000n, minResult: 1n, maxResult: 1n, attestor: wallet, specHash: new Uint8Array(32).fill(9), judgeFee: 0n } as const;
    const sdk = createClient({ url: "http://cluster", transport });
    const partnered = await sdk.createIntent({ signer: owner, params, inputMint: token, outputMint: other, partner, partnerBps: 40 });
    await announced(partnered.intent, coauthor, WORK);
    const shown = await ok(client, "wallet_attest_split", { owner: owner.address, nonce: String(partnered.nonce), recipients, delivered_sha256: WORK });
    const partnerAccount = await findAssociatedTokenAddress({ owner: partner, mint: token, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(shown["lookup_accounts"]).toContain(partnerAccount);
    const held = h.svm.getAccount(partnered.intent);
    if (!held.exists) {
      throw new Error("the escrow was not created");
    }
    const intent = getIntentDecoder().decode(held.data);
    const fees = splitFees(10_000n, intent.feeBps, intent.partnerBps, intent.partnerCutBps);
    expect(fees.partner).toBeGreaterThan(0n);
    expect(shown["fee"]).toBe(formatAmount(fees.protocol + fees.partner, 6));
    const plain = await sdk.createIntent({ signer: owner, params, inputMint: token, outputMint: other });
    await announced(plain.intent, coauthor, WORK);
    const bare = await ok(client, "wallet_attest_split", { owner: owner.address, nonce: String(plain.nonce), recipients, delivered_sha256: WORK });
    const left = h.svm.getAccount(plain.intent);
    if (!left.exists) {
      throw new Error("the escrow was not created");
    }
    const unpartnered = await findAssociatedTokenAddress({ owner: getIntentDecoder().decode(left.data).partner, mint: token, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(bare["lookup_accounts"]).not.toContain(unpartnered);
    expect(bare["lookup_accounts"]).not.toContain(partnerAccount);
  });

  it("asks for no treasury account when no protocol fee is owed", async () => {
    const { shown } = await split(true, "0.05", "0.001");
    expect(shown["lookup_accounts"]).not.toContain(await treasuryAccount());
    expect(shown).toMatchObject({ fee: "0.001" });
  });
});

describe("the committee tools of a wallet outside the committee", () => {
  async function committeeJob() {
    const client = await fresh();
    const first = await deviceKey();
    h.svm.airdrop(first.address, lamports(10_000_000_000n));
    const second = await keyed();
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(wallet);
    const profile = await keyedProfile(first, "member.enc");
    h.engineLog = [profile.entry];
    const members = sortMembers([first.address, second.address]);
    const payer = await funded();
    const created = await cli(["committee", "create", "--url", "devnet", "--keypair", "payer.json", "--members", members.join(","), "--threshold", "2", "--fee-wallet", payer.address, "--yes"], { "payer.json": payer });
    expect(created.code).toBe(0);
    const committee = created.json()["committee"] as Address;
    const made = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: committee, spec_hash: "6d".repeat(32) }));
    const worker = await keyed();
    const opening = await announced(made["intent"] as Address, worker, WORK);
    const opener = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools", "--encryption-keypair", "member.enc"]);
    const ballot = { owner: wallet, nonce: made["nonce"] as string, result: "1", delivered_sha256: WORK };
    const target = { intent: { owner: wallet, nonce: BigInt(ballot.nonce) }, announcement: opening.announcement, opening: { sha256: WORK, salt: opening.salt }, result: 1n };
    const digest = await createClient({ url: "http://cluster", transport }).committeeBallot(target);
    const votes = await Promise.all(
      [first.signer, second].map(async (member) => {
        const signed = await signCommitteeVote(member, digest.digest, digest.committee.members);
        return { member: signed.member, signature: getBase16Decoder().decode(signed.signature).toLowerCase() };
      }),
    );
    return { client: opener, wallet, ballot, votes };
  }

  beforeEach(() => {
    forced.setup = undefined;
  });

  it("lets any wallet that opens the announcement collect the votes and release, though it sits on no committee", async () => {
    const { client, wallet, ballot, votes } = await committeeJob();
    const shown = await ok(client, "wallet_committee_release", { ...ballot, votes });
    expect(shown).toMatchObject({ signers: sortMembers(votes.map(({ member }) => member)), sent: false });
    expect(JSON.stringify(shown["summary"])).toContain(`Pays the fee: this server's wallet ${wallet}`);
  });

  it("previews a committee without preparing its creation", async () => {
    const client = await fresh();
    await ok(client, "wallet_setup");
    const members = [(await keyed()).address, (await keyed()).address];
    const simulated = h.simulated.length;
    const preview = await ok(client, "wallet_committee_create", { members, threshold: 2 });
    expect(h.simulated.length).toBe(simulated);
    expect(preview).toMatchObject({ exists: false, sent: false });
    expect(preview).not.toHaveProperty("prepared");
  });

  it("refuses a release whose setup instruction does not name the token account it creates", async () => {
    const { client, ballot, votes } = await committeeJob();
    const where = (await keyed()).address;
    const named = (hole: number): Instruction => ({
      programAddress: where,
      accounts: Array.from({ length: 6 }, (_, at) => ({ address: (at === hole ? undefined : where) as unknown as Address, role: 0 })),
    });
    for (const broken of [named(1), named(3), named(5)]) {
      forced.setup = [broken];
      const refused = await call(client, "wallet_committee_release", { ...ballot, votes });
      expect(refused.error).toBe(true);
      expect(JSON.stringify(refused.value)).toContain("a release setup instruction names no token account");
    }
  });
});
