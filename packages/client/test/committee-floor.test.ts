import { AccountRole, type Address, generateKeyPairSigner, type Instruction } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { type AttestedResultParams, buildSetCommitteeFloor, findIntentPda, INTENT_ENGINE_PROGRAM_ADDRESS, Kind, sortMembers } from "@intent-engine/core";
import { CommitteeNeeded, createClient, escrowCommittee, type IntentPlacement, loadConfig } from "../src/index.js";
import { funded, world, type World } from "./svm.js";

const LOCAL = "http://127.0.0.1:8899";
const FLOOR = 500n;

function recording(w: World) {
  const sent: Instruction[][] = [];
  const inner = w.chain.transport;
  const client = createClient({
    url: LOCAL,
    transport: { ...inner, send: async (instructions, payer) => (sent.push([...instructions]), inner.send(instructions, payer)) },
  });
  const created = () => sent.flat().filter((ix) => ix.programAddress === INTENT_ENGINE_PROGRAM_ADDRESS).at(-1);
  return { client, created, sent };
}

const proof = (w: World, amountIn: bigint, attestor: Address, nonce: bigint): IntentPlacement & { params: AttestedResultParams } => ({
  signer: w.owner,
  params: { kind: Kind.AttestedResult, amountIn, minResult: 1n, maxResult: 1n, attestor, specHash: new Uint8Array(32), judgeFee: 0n },
  inputMint: w.inputMint,
  outputMint: w.outputMint,
  nonce,
});

async function convene(w: World, client: ReturnType<typeof createClient>, threshold: number): Promise<Address> {
  const members = sortMembers(await Promise.all([0, 1, 2].map(async () => (await generateKeyPairSigner()).address)));
  const payer = await funded(w.chain);
  return (await client.createCommittee({ payer, members, threshold, feeWallet: payer.address })).committee;
}

describe("committee floor", () => {
  it("a create at the floor with a single judge is refused before sending", async () => {
    const w = await world();
    const { client, sent } = recording(w);
    await w.chain.transport.send([await buildSetCommitteeFloor({ admin: w.authority, mint: w.inputMint, floor: FLOOR })], w.authority);
    const judge = (await generateKeyPairSigner()).address;
    const before = sent.length;
    const refused = await client.createIntent(proof(w, FLOOR, judge, 0n)).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(CommitteeNeeded);
    expect(refused).toMatchObject({ attestor: judge, escrow: FLOOR, floor: FLOOR });
    expect(sent.length).toBe(before);
    expect(await w.chain.transport.getAccount((await findIntentPda({ owner: w.owner.address, nonce: 0n }))[0])).toBeNull();
    await client.createIntent(proof(w, FLOOR - 1n, judge, 0n));
    expect((await client.intent({ owner: w.owner.address, nonce: 0n }))?.intent.escrowed).toBe(FLOOR - 1n);
  });

  it("a create passes its committee and counts only a threshold of two or more", async () => {
    const w = await world();
    const { client, created } = recording(w);
    await w.chain.transport.send([await buildSetCommitteeFloor({ admin: w.authority, mint: w.inputMint, floor: FLOOR })], w.authority);
    const loose = await convene(w, client, 1);
    const { config } = await loadConfig(w.chain.transport);
    const params = proof(w, FLOOR, loose, 0n).params;
    await expect(escrowCommittee(w.chain.transport, config, w.inputMint, params)).rejects.toThrow(CommitteeNeeded);
    await expect(client.createIntent(proof(w, FLOOR, loose, 0n))).rejects.toThrow(CommitteeNeeded);

    const committee = await convene(w, client, 2);
    await client.createIntent(proof(w, FLOOR, committee, 0n));
    expect(created()?.accounts?.at(-4)).toEqual({ address: committee, role: AccountRole.READONLY });
    expect((await client.intent({ owner: w.owner.address, nonce: 0n }))?.intent.escrowed).toBe(FLOOR);

    await client.createIntent(proof(w, 1n, loose, 1n));
    expect(created()?.accounts?.at(-4)).toEqual({ address: loose, role: AccountRole.READONLY });
    await client.createIntent({ ...proof(w, 1n, loose, 2n), params: { kind: Kind.SwapExactIn, amountIn: 1n, minOut: 1n } });
    expect(created()?.accounts?.at(-4)).toEqual({ address: INTENT_ENGINE_PROGRAM_ADDRESS, role: AccountRole.READONLY });
  });
});
