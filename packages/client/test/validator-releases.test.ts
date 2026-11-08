import { createHash } from "node:crypto";
import {
  AccountRole,
  type Address,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  getU32Encoder,
  getU64Encoder,
  type Instruction,
  type KeyPairSigner,
  type Signature,
} from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstructionAsync, getMintToInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { attestedResult, findAssociatedTokenAddress, IntentStatus, splitFees } from "@intent-engine/core";
import { buildClaimJob, buildDropClaim, buildOpenClaims, INTENT_ENGINE_PROGRAM_ADDRESS, signCommitteeVote, signMessageBytes, splitN } from "@intent-engine/core/internal";
import { createClient, type LookupTables } from "../src/index.js";
import { confirmSent, PACKET_DATA_SIZE, type RpcLike } from "../src/internal.js";
import { authorityFile, chainOf, FEE_BPS, signedWithTables, url } from "./validator-harness.js";

const PAY = 100_000n;
const STAKE = 50_000_000n;
const SIGNATURE_FEE = 5_000n;
const WEIGHTS = [6_000, 4_000];
const SPEC = new Uint8Array(createHash("sha256").update("the release paths spec").digest());
const WORK = createHash("sha256").update("the released work").digest("hex");
const WORK_URL = "https://" + "example.org/work.tar";
const LOOKUP_TABLE_PROGRAM = "AddressLookupTab1e1111111111111111111111111" as Address;
const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;
const TIMEOUT = { timeout: 240_000 };

describe.skipIf(url === undefined || authorityFile === undefined)("every release path against a real validator", () => {
  const http = url ?? "http://" + "127.0.0.1:8899";
  const chain = chainOf(http);
  const { rpc, watch, plain, funded } = chain;
  const client = createClient({ url: http, transport: plain });

  const build = async () => {
    const authority = await chain.authority();
    await chain.configured(client.send, authority);
    return { authority, inputMint: await chain.mint(client.send, authority), outputMint: await chain.mint(client.send, authority) };
  };
  let ready: ReturnType<typeof build> | undefined;
  const setup = () => (ready ??= build());

  const ata = (owner: Address, mint: Address) => findAssociatedTokenAddress({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });

  const tokens = async (owner: Address, mint: Address): Promise<bigint> => {
    const account = await plain.getAccount(await ata(owner, mint));
    return account === null ? 0n : new DataView(account.data.buffer, account.data.byteOffset).getBigUint64(64, true);
  };

  const lamportsOf = async (wallet: Address) => (await rpc.getBalance(wallet, { commitment: "confirmed" }).send()).value;

  const escrow = async (attestor: Address, judgeFee = 0n) => {
    const { authority, inputMint, outputMint } = await setup();
    const owner = await funded(2n);
    await client.send(
      [
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: authority, owner: owner.address, mint: inputMint }),
        getMintToInstruction({ mint: inputMint, token: await ata(owner.address, inputMint), mintAuthority: authority, amount: PAY }),
      ],
      authority,
    );
    const params = attestedResult({ amountIn: PAY, minResult: 1n, maxResult: 1n, attestor, specHash: SPEC, judgeFee });
    const made = await client.createIntent({ signer: owner, inputMint, outputMint, params });
    return { owner, inputMint, intent: made.intent, ref: { owner: owner.address, nonce: made.nonce } };
  };

  const delivered = async (worker: KeyPairSigner, intent: Address) => {
    const done = await client.announce({ worker, intent, sha256: WORK, url: WORK_URL });
    return { announcement: done.announcement, opening: { sha256: WORK, salt: done.salt } };
  };

  const filled = async (ref: { owner: Address; nonce: bigint }) => (await client.intent(ref))?.intent.status;

  const lookupTable = async (authority: KeyPairSigner, addresses: readonly Address[]): Promise<Address> => {
    const slot = await rpc.getSlot({ commitment: "finalized" }).send();
    const [table, bump] = await getProgramDerivedAddress({
      programAddress: LOOKUP_TABLE_PROGRAM,
      seeds: [getAddressEncoder().encode(authority.address), getU64Encoder().encode(slot)],
    });
    const accounts = [
      { address: table, role: AccountRole.WRITABLE },
      { address: authority.address, role: AccountRole.READONLY_SIGNER, signer: authority },
      { address: authority.address, role: AccountRole.WRITABLE_SIGNER, signer: authority },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ];
    const create: Instruction = {
      programAddress: LOOKUP_TABLE_PROGRAM,
      accounts,
      data: Uint8Array.from([...getU32Encoder().encode(0), ...getU64Encoder().encode(slot), bump]),
    };
    const extend: Instruction = {
      programAddress: LOOKUP_TABLE_PROGRAM,
      accounts,
      data: Uint8Array.from([
        ...getU32Encoder().encode(2),
        ...getU64Encoder().encode(BigInt(addresses.length)),
        ...addresses.flatMap((a) => [...getAddressEncoder().encode(a)]),
      ]),
    };
    await client.send([create], authority);
    const extended = await client.send([extend], authority);
    const landed = (await rpc.getSignatureStatuses([extended]).send()).value[0]?.slot ?? 0n;
    while ((await rpc.getSlot({ commitment: "confirmed" }).send()) <= landed) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return table;
  };

  const sendTabled = async (instructions: readonly Instruction[], payer: KeyPairSigner, tables: LookupTables): Promise<Signature> => {
    const latest = await plain.latestBlockhash();
    const transaction = await signedWithTables(await plain.budget(instructions, payer.address, tables), payer, latest, tables);
    const wire = getBase64EncodedWireTransaction(transaction);
    expect(getBase64Encoder().encode(wire).length).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    const signature = getSignatureFromTransaction(transaction);
    await plain.submitWire(wire);
    await confirmSent(rpc as unknown as RpcLike, signature, latest.lastValidBlockHeight, undefined, watch);
    return signature;
  };

  it("releases a proof escrow to its worker on the judge's signature", TIMEOUT, async () => {
    const [judge, worker] = await Promise.all([funded(1n), funded(1n)]);
    const job = await escrow(judge.address);
    const made = await delivered(worker, job.intent);
    await client.settleProof({ judge, intent: job.ref, ...made, result: 1n });
    expect(await tokens(worker.address, job.inputMint)).toBe(splitFees(PAY, FEE_BPS, 0, 0).net);
    expect(await filled(job.ref)).toBe(IntentStatus.Filled);
  });

  it("releases a two co-author split through an address lookup table that lands on the cluster", TIMEOUT, async () => {
    const [judge, worker, coauthor] = await Promise.all([funded(2n), funded(1n), funded(1n)]);
    const job = await escrow(judge.address);
    const made = await delivered(worker, job.intent);
    const recipients = [
      { wallet: worker.address, weight: WEIGHTS[0] ?? 0 },
      { wallet: coauthor.address, weight: WEIGHTS[1] ?? 0 },
    ];
    const target = { intent: job.ref, ...made, result: 1n, recipients };
    const ballot = await client.splitBallot(target);
    const signatures = await Promise.all([worker, coauthor].map(async (s) => ({ wallet: s.address, signature: await signMessageBytes(s, ballot.message) })));
    const plan = await client.plan.settleSplit({ ...target, judge, signatures });
    if (plan.setup.length > 0) {
      await client.send(plan.setup, judge);
    }
    const settle = plan.instructions.at(-1);
    const skipped = new Set<Address>([INTENT_ENGINE_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, judge.address]);
    const looked = [...new Set((settle?.accounts ?? []).map((a) => a.address))].filter((a) => !skipped.has(a));
    const table = await lookupTable(judge, looked);
    const signature = await sendTabled(plan.instructions, judge, { [table]: looked });
    const landed = await rpc.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" }).send();
    expect(landed?.version).toBe(0);
    const message = landed?.transaction.message as { addressTableLookups?: readonly { accountKey: Address }[] } | undefined;
    expect(message?.addressTableLookups?.map((l) => l.accountKey)).toEqual([table]);
    const { net } = splitFees(PAY, FEE_BPS, 0, 0);
    expect([await tokens(worker.address, job.inputMint), await tokens(coauthor.address, job.inputMint)]).toEqual(splitN(net, WEIGHTS));
    expect(await filled(job.ref)).toBe(IntentStatus.Filled);
  });

  it("releases a committee escrow on a quorum of member votes", TIMEOUT, async () => {
    const [creator, feeWallet, worker, ...members] = await Promise.all([funded(2n), funded(1n), funded(1n), funded(1n), funded(1n), funded(1n)]);
    const { committee } = await client.createCommittee({ payer: creator, members: members.map((m) => m.address), threshold: 2, feeWallet: feeWallet.address });
    const job = await escrow(committee);
    const made = await delivered(worker, job.intent);
    const target = { intent: job.ref, ...made, result: 1n };
    const ballot = await client.committeeBallot(target);
    const votes = await Promise.all(members.slice(0, 2).map((m) => signCommitteeVote(m, ballot.digest, ballot.committee.members)));
    await client.settleCommittee({ ...target, solver: creator, votes });
    expect(await tokens(worker.address, job.inputMint)).toBe(splitFees(PAY, FEE_BPS, 0, 0).net);
    expect(await filled(job.ref)).toBe(IntentStatus.Filled);
  });

  it("rejects an announcement and leaves the escrow open and whole", TIMEOUT, async () => {
    const [judge, worker] = await Promise.all([funded(1n), funded(1n)]);
    const job = await escrow(judge.address);
    const made = await delivered(worker, job.intent);
    await client.reject({ judge, intent: job.ref, announcement: made.announcement });
    expect((await client.announcements(job.intent)).announcements.map(({ state }) => state)).toEqual(["rejected"]);
    expect(await filled(job.ref)).toBe(IntentStatus.Open);
    expect(await tokens(worker.address, job.inputMint)).toBe(0n);
  });

  it("takes a claim with a stake and drops it with the stake back", TIMEOUT, async () => {
    const [judge, worker] = await Promise.all([funded(1n), funded(1n)]);
    const job = await escrow(judge.address);
    await client.send([await buildOpenClaims({ owner: job.owner, intent: job.intent, maxSecs: 3_600, stake: STAKE })], job.owner);
    const before = await lamportsOf(worker.address);
    await client.send([await buildClaimJob({ worker, intent: job.intent, owner: job.owner.address, secs: 600 })], worker);
    expect(await client.claims(job.ref)).toMatchObject({ state: "held", worker: worker.address, stake: STAKE });
    const held = await lamportsOf(worker.address);
    expect(before - held).toBe(STAKE + SIGNATURE_FEE);
    await client.send([await buildDropClaim({ worker, intent: job.intent })], worker);
    expect(await client.claims(job.ref)).toMatchObject({ state: "free", worker: null });
    expect((await lamportsOf(worker.address)) - held).toBe(STAKE - SIGNATURE_FEE);
  });
});
