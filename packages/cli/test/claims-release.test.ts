import { type Address, generateKeyPairSigner, getBase16Decoder, getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, lamports, none, signBytes } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { buildClaimJob, claimBoardAddress, DEVNET_TEST_MINT, findAssociatedTokenAddress, formatAmount, NATIVE_MINT, signCommitteeVote, sortMembers, specMemo, splitFee } from "@intent-engine/core";
import { createClient, noJudgeKey, WARN_NO_JUDGE_KEY } from "@intent-engine/client";
import { claimHeldBy } from "../src/agent/wallet/attest.js";
import { CLAIMS_ADVICE, CLAIMS_NEED_SPEC, CLAIMS_TOGETHER, claimsLine, PIECE_ONE, SPEC_ANSWER_OUT, SPEC_NO_ANSWER } from "../src/agent/wallet/escrow.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_OK } from "../src/main.js";
import { LAMPORTS_PER_SOL } from "../src/wallet.js";
import { sealedDelivery } from "./announce.js";
import { balance, cli, creation, FEE_BPS, funded, h, send, transport, world } from "./harness.js";

type Json = Record<string, unknown> & { [key: string]: any };

const SPEC_HASH = "7c".repeat(32);
const SPEC_URL = "https://" + "example.org/jobs/claimed.md";
const STAKE = LAMPORTS_PER_SOL / 20n;
const WORK = "d4".repeat(32);

function preset(at: Address): void {
  const space = BigInt(getMintSize());
  h.svm.setAccount({
    address: at,
    data: Uint8Array.from(getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals: 9, isInitialized: true, freezeAuthority: none() })),
    executable: false,
    lamports: lamports(h.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
}

async function connect(): Promise<Client> {
  h.served.length = 0;
  const started = await cli(["mcp", "--url", "devnet", "--wallet", "--all-tools"], {});
  expect([started.code, started.err]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

async function call(client: Client, name: string, args: object = {}) {
  const result = await client.callTool({ name: `solive_${name}`, arguments: args as Record<string, unknown> });
  return { error: result.isError === true, value: result.structuredContent as Json };
}

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const { error, value } = await call(client, name, args);
  expect(error, JSON.stringify(value)).toBe(false);
  return value;
}

const accountsOf = (wire: string): Address[] =>
  [...getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(getBase64Encoder().encode(wire)).messageBytes).staticAccounts];

const sol = (address: Address) => h.svm.getBalance(address) ?? 0n;

async function claimed(client: Client, wallet: Address, attestor: Address) {
  const escrow = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor, spec_hash: SPEC_HASH, claim_stake: "0.05", claim_secs: 3600, send: true });
  const intent = escrow["intent"] as Address;
  const nonce = escrow["nonce"] as string;
  const worker = await funded();
  await send(worker, [await buildClaimJob({ worker, intent, owner: wallet, secs: 600 })]);
  const held = await ok(client, "get_claims", { owner: wallet, nonce });
  expect(held).toMatchObject({ takes_claims: true, state: "held", worker: worker.address });
  return { intent, nonce, worker, until: BigInt(held["until"] as string), rival: (await funded()).address };
}

describe("claims from the wallet tools", () => {
  let client: Client;
  let wallet: Address;

  beforeEach(async () => {
    await world();
    h.files.clear();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    client = await connect();
    wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(wallet);
    h.engineLog = [];
  });

  it("wallet_escrow opens claims in the same send, so get_claims reports the escrow takes them", async () => {
    const base = { sell: "SOL", amount: "0.05", attestor: wallet, spec_hash: SPEC_HASH };
    const wires = h.wires.length;
    expect((await call(client, "wallet_escrow", { ...base, claim_stake: "0.05" })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "claim_secs", message: CLAIMS_TOGETHER }] });
    expect((await call(client, "wallet_escrow", { ...base, claim_secs: 60 })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "claim_stake", message: CLAIMS_TOGETHER }] });
    expect((await call(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: wallet, claim_stake: "0.05", claim_secs: 60 })).value).toMatchObject({
      code: "InvalidInput",
      issues: [{ path: "claim_stake", message: CLAIMS_NEED_SPEC }],
    });
    expect((await call(client, "wallet_escrow", { ...base, claim_stake: "101", claim_secs: 60 })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "claim_stake" }] });
    const preview = await ok(client, "wallet_escrow", { ...base, claim_stake: "0.05", claim_secs: 3600 });
    expect(preview["summary"]).toContain(claimsLine(3600, "0.05", false));
    expect(claimsLine(3600, "0.05", false)).toContain("a worker can hold the job for up to 3600 seconds by staking 0.05 SOL");
    expect(preview["warnings"]).toContain(SPEC_ANSWER_OUT);
    expect(JSON.stringify(preview["warnings"])).not.toContain(CLAIMS_ADVICE);
    expect(SPEC_NO_ANSWER).toContain("give claim_stake and claim_secs to open claims");
    expect(SPEC_NO_ANSWER).not.toContain("intent-engine");
    expect(h.wires.length).toBe(wires);
    const sent = await ok(client, "wallet_escrow", { ...base, claim_stake: "0.05", claim_secs: 3600, send: true });
    expect(h.wires.length).toBe(wires + 1);
    expect(await ok(client, "get_claims", { owner: wallet, nonce: sent["nonce"] })).toMatchObject({
      takes_claims: true,
      board: await claimBoardAddress(sent["intent"] as Address),
      state: "free",
      stake: STAKE.toString(),
      max_secs: 3600,
      owner: wallet,
    });
    const plain = await ok(client, "wallet_escrow", { ...base, send: true });
    expect(await ok(client, "get_claims", { owner: wallet, nonce: plain["nonce"] })).toEqual({ intent: plain["intent"], takes_claims: false, escrow: "open" });
  });

  it("wallet_attest passes the claims board, pays the claiming worker and returns its stake, and refuses another payee before sending", async () => {
    const job = await claimed(client, wallet, wallet);
    h.engineLog = [creation(job.intent)];
    const board = await claimBoardAddress(job.intent);
    const release = { owner: wallet, nonce: job.nonce, delivered_sha256: WORK, received_outside_announcement: true };
    const wires = h.wires.length;
    for (const args of [{ ...release, pay_to: job.rival }, { ...release, pay_to: job.rival, approval: "0".repeat(16), send: true }]) {
      expect((await call(client, "wallet_attest", args)).value).toMatchObject({ code: "ClaimHeld", hint: claimHeldBy(job.worker.address, job.until) });
    }
    expect(claimHeldBy(job.worker.address, job.until)).toContain(`${job.worker.address} holds this job's claim until ${new Date(Number(job.until) * 1000).toISOString()}`);
    expect(h.wires.length).toBe(wires);
    const shown = await ok(client, "wallet_attest", { ...release, pay_to: job.worker.address });
    expect(shown["summary"]).toContain(`Returns: the claim stake of 0.05 SOL to ${job.worker.address}`);
    const before = sol(job.worker.address);
    const done = await ok(client, "wallet_attest", { ...release, pay_to: job.worker.address, approval: shown["approval"], send: true });
    expect(done).toMatchObject({ sent: true, signature: expect.any(String) });
    expect(accountsOf(h.wires[h.wires.length - 1] as string)).toContain(board);
    const { net } = splitFee(LAMPORTS_PER_SOL / 20n, FEE_BPS);
    const paid = await findAssociatedTokenAddress({ owner: job.worker.address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(balance(paid)).toBe(net);
    expect(formatAmount(net, 9)).toBe(done["paid"]);
    expect(sol(job.worker.address) - before).toBe(STAKE);
  });

  it("wallet_attest_split passes the claims board and refuses a split that leaves out the claiming worker", async () => {
    const job = await claimed(client, wallet, wallet);
    h.engineLog = [creation(job.intent)];
    const release = { owner: wallet, nonce: job.nonce, delivered_sha256: WORK, received_outside_announcement: true };
    expect((await call(client, "wallet_attest_split", { ...release, recipients: [{ wallet: job.rival, weight: 10000 }] })).value).toMatchObject({
      code: "ClaimHeld",
      hint: claimHeldBy(job.worker.address, job.until),
    });
    const recipients = [{ wallet: job.worker.address, weight: 10000 }];
    const shown = await ok(client, "wallet_attest_split", { ...release, recipients });
    expect(shown["summary"]).toContain(`Returns: the claim stake of 0.05 SOL to ${job.worker.address}`);
    const envelope = Uint8Array.from(Buffer.from(shown["envelope"] as string, "hex"));
    const signature = getBase16Decoder().decode(new Uint8Array(await signBytes(job.worker.keyPair.privateKey, envelope)));
    const before = sol(job.worker.address);
    const done = await ok(client, "wallet_attest_split", { ...release, recipients: [{ ...recipients[0], signature }], approval: shown["approval"], send: true });
    expect(done).toMatchObject({ sent: true });
    expect(sol(job.worker.address) - before).toBe(STAKE);
  });

  it("wallet_escrow_plan opens claims on every piece, marks the lines of piece 1, and drops the Ledger warning for its own key", async () => {
    const plan = {
      sell: "SOL",
      attestor: wallet,
      spec_hash: SPEC_HASH,
      spec_url: SPEC_URL,
      pieces: [
        { name: "parser", amount: "0.02" },
        { name: "page", amount: "0.03" },
      ],
    };
    expect((await call(client, "wallet_escrow_plan", { ...plan, spec_hash: undefined, spec_url: undefined, claim_stake: "0.05", claim_secs: 60 })).value).toMatchObject({
      code: "InvalidInput",
      issues: [{ path: "pieces.0.spec_hash", message: CLAIMS_NEED_SPEC }],
    });
    expect((await call(client, "wallet_escrow_plan", { ...plan, claim_secs: 60 })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "claim_stake" }] });
    const preview = await ok(client, "wallet_escrow_plan", { ...plan, claim_stake: "0.05", claim_secs: 3600 });
    const summary = preview["summary"] as string[];
    expect(summary).toContain(claimsLine(3600, "0.05", true));
    expect(summary).toContain(`${PIECE_ONE}: Publishes: the acceptance spec's url ${SPEC_URL}, in a memo the owner signs`);
    const after = summary.slice(summary.indexOf(claimsLine(3600, "0.05", true)) + 1);
    expect(after.length).toBeGreaterThan(1);
    expect(after.every((line) => line.startsWith(`${PIECE_ONE}: `))).toBe(true);
    expect(summary.filter((line) => /^(Sell|Publishes|Expires):/.test(line))).toEqual([]);
    expect(JSON.stringify(preview["warnings"])).not.toContain(WARN_NO_JUDGE_KEY);
    const other = (await funded()).address;
    const hired = await ok(client, "wallet_escrow_plan", { ...plan, attestor: other });
    expect(hired["warnings"]).toContain(noJudgeKey(other));
    const sent = await ok(client, "wallet_escrow_plan", { ...plan, claim_stake: "0.05", claim_secs: 3600, send: true });
    for (const piece of sent["pieces"] as Json[]) {
      expect(await ok(client, "get_claims", { owner: wallet, nonce: piece["nonce"] })).toMatchObject({ takes_claims: true, stake: STAKE.toString(), max_secs: 3600 });
    }
    expect(h.wires.some((wire) => Buffer.from(wire, "base64").toString("latin1").includes(specMemo(SPEC_URL)))).toBe(true);
  });

  it("the committee tools refuse another payee while a claim holds, and the release pays the claiming worker its stake back", async () => {
    const other = await generateKeyPairSigner();
    const payer = await funded();
    const members = sortMembers([wallet, other.address]);
    const created = await cli(
      ["committee", "create", "--url", "devnet", "--keypair", "payer.json", "--members", members.join(","), "--threshold", "2", "--fee-wallet", payer.address, "--yes"],
      { "payer.json": payer },
    );
    expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
    const committee = created.json()["committee"] as Address;
    const job = await claimed(client, wallet, committee);
    const memo = await sealedDelivery(job.intent, job.worker.address, WORK, "https://" + "example.org/work", members);
    h.engineLog = [{ signature: "first", slot: 5n, blockTime: null, failed: false, emitted: [], memos: [memo], feePayer: job.worker.address }, creation(job.intent)];
    const ballot = { owner: wallet, nonce: job.nonce, pay_to: job.worker.address, result: "1", delivered_sha256: WORK };
    const held = { code: "ClaimHeld", hint: claimHeldBy(job.worker.address, job.until) };
    expect((await call(client, "wallet_committee_vote", { ...ballot, pay_to: job.rival })).value).toMatchObject(held);
    const preview = await ok(client, "wallet_committee_vote", ballot);
    const own = (await ok(client, "wallet_committee_vote", { ...ballot, approval: preview["approval"], send: true }))["vote"] as { member: Address; signature: string };
    const ballotOf = await createClient({ url: "http://cluster", transport }).committeeBallot({ owner: wallet, nonce: BigInt(job.nonce), payTo: job.worker.address, result: 1n });
    const theirs = await signCommitteeVote(other, ballotOf.digest, ballotOf.committee.members);
    const votes = [own, { member: theirs.member, signature: getBase16Decoder().decode(theirs.signature).toLowerCase() }];
    expect((await call(client, "wallet_committee_release", { ...ballot, pay_to: job.rival, votes })).value).toMatchObject(held);
    const shown = await ok(client, "wallet_committee_release", { ...ballot, votes });
    const before = sol(job.worker.address);
    expect(await ok(client, "wallet_committee_release", { ...ballot, votes, approval: shown["approval"], send: true })).toMatchObject({ sent: true });
    expect(sol(job.worker.address) - before).toBe(STAKE);
  });
});
