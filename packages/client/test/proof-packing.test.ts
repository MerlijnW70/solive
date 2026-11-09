import { type Instruction, type KeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Kind, NATIVE_MINT } from "@intent-engine/core";
import { ED25519_PROGRAM_ADDRESS, signCommitteeVote, sortMembers } from "@intent-engine/core/internal";
import { createClient } from "../src/index.js";
import { loadConfig, mintOf, PACKET_DATA_SIZE } from "../src/internal.js";
import { proofSettlement } from "../src/client-settle.js";
import { world, type World } from "./svm.js";
import { announced, fundedSigner, LOCAL, nativeMint, sha, specHash, tokensOf } from "./work.js";
import { sentWithTable } from "./table-kit.js";

const WORK = sha("the packed work");

async function job(w: World) {
  nativeMint(w);
  const client = createClient({ url: LOCAL, transport: w.chain.transport });
  const [owner, judge, worker] = await Promise.all([fundedSigner(w), fundedSigner(w), fundedSigner(w)]);
  const params = { kind: Kind.AttestedResult, amountIn: 1_000_000n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: specHash("the packed spec"), judgeFee: 1_000n } as const;
  const made = await client.createIntent({ signer: owner, params, inputMint: NATIVE_MINT, outputMint: w.outputMint });
  const delivered = await announced(client, worker, made.intent, WORK);
  return { owner, judge, nonce: made.nonce, intent: made.intent, delivered };
}

const planner = (w: World, bytes: (instructions: readonly Instruction[]) => number) =>
  proofSettlement({
    transport: w.chain.transport,
    send: async () => {
      throw new Error("planning sends nothing");
    },
    bytes: async (instructions) => bytes(instructions),
    mint: async (address) => mintOf(w.chain.transport, address),
    config: async () => (await loadConfig(w.chain.transport)).config,
  });

const isRelease = (ix: Instruction) => ix.programAddress === ED25519_PROGRAM_ADDRESS;

describe("a proof release plan at the packet limit", () => {
  it("keeps the token account setup in the release transaction while it measures 1232 bytes", async () => {
    const w = await world();
    const j = await job(w);
    const input = { judge: j.judge as KeyPairSigner, intent: { owner: j.owner.address, nonce: j.nonce }, ...j.delivered, result: 1n };
    const plan = await planner(w, () => PACKET_DATA_SIZE)(input);
    expect(plan.setup).toEqual([]);
    expect(plan.instructions.length).toBeGreaterThan(2);
    expect(plan.instructions.at(-2)?.programAddress).toBe(ED25519_PROGRAM_ADDRESS);
  });

  it("sends the setup first once the release with it measures 1233 bytes, and refuses a release that measures 1233 bytes alone", async () => {
    const w = await world();
    const j = await job(w);
    const input = { judge: j.judge as KeyPairSigner, intent: { owner: j.owner.address, nonce: j.nonce }, ...j.delivered, result: 1n };
    const split = await planner(w, (instructions) => (instructions.length > 2 ? PACKET_DATA_SIZE + 1 : PACKET_DATA_SIZE))(input);
    expect(split.setup.length).toBeGreaterThan(0);
    expect(split.setup.some(isRelease)).toBe(false);
    expect(split.instructions).toHaveLength(2);
    expect(split.instructions[0]?.programAddress).toBe(ED25519_PROGRAM_ADDRESS);
    await expect(planner(w, () => PACKET_DATA_SIZE + 1)(input)).rejects.toMatchObject({ code: "not-settleable", reason: "too-large", intent: j.intent });
    await expect(createClient({ url: LOCAL, transport: w.chain.transport }).plan.settleProof(input)).resolves.toMatchObject({ setup: [] });
  });

  it("refuses to send a eight-member committee release that cannot land without a table, which lands through one", async () => {
    const w = await world();
    nativeMint(w);
    const client = createClient({ url: LOCAL, transport: w.chain.transport });
    const members = await Promise.all(Array.from({ length: 8 }, () => fundedSigner(w)));
    const [owner, worker, solver] = await Promise.all([fundedSigner(w), fundedSigner(w), fundedSigner(w)]);
    const { committee } = await client.createCommittee({ payer: solver, members: sortMembers(members.map(({ address }) => address)), threshold: 3, feeWallet: solver.address });
    const params = { kind: Kind.AttestedResult, amountIn: 1_000_000n, minResult: 1n, maxResult: 1n, attestor: committee, specHash: specHash("the committee spec"), judgeFee: 0n } as const;
    const made = await client.createIntent({ signer: owner, params, inputMint: NATIVE_MINT, outputMint: w.outputMint });
    const delivered = await announced(client, worker, made.intent, WORK);
    const target = { intent: { owner: owner.address, nonce: made.nonce }, ...delivered, result: 1n };
    const ballot = await client.committeeBallot(target);
    const votes = await Promise.all(members.slice(0, 3).map((member) => signCommitteeVote(member, ballot.digest, ballot.committee.members)));
    await expect(client.settleCommittee({ ...target, solver, votes })).rejects.toMatchObject({ code: "not-settleable", reason: "too-large", intent: made.intent });
    expect(await tokensOf(w, worker.address)).toBeNull();
    const planned = await client.plan.settleCommittee({ ...target, solver, votes });
    if (planned.setup.length > 0) {
      await client.send(planned.setup, solver);
    }
    await sentWithTable(w, planned.instructions, solver);
    expect(await tokensOf(w, worker.address)).toBeGreaterThan(0n);
  });
});
