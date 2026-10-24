import { type Address, getAddressEncoder, getBase58Decoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  attestedResult,
  DEVNET_TEST_MINT,
  getIntentDecoder,
  getIntentEncoder,
  IntentStatus,
  Kind,
  limitOrder,
  NATIVE_MINT,
  swapExactIn,
} from "@intent-engine/core";
import {
  ATTESTED_ATTESTOR_AT,
  ATTESTOR_NEEDS_ATTESTED,
  createClient,
  INTENT_INPUT_MINT_AT,
  INTENT_KIND_AT,
  INTENT_OUTPUT_MINT_AT,
  INTENT_OWNER_AT,
  INTENT_STATUS_AT,
  type IntentQuery,
  type RpcLike,
  rpcTransport,
  type Transport,
} from "../src/index.js";
import { createTestWorld, type TestWorld } from "../src/testing.js";
import { SPEC } from "./plan-driver.js";

const proof = (attestor: Address) => attestedResult({ amountIn: 1_000_000n, minResult: 1n, maxResult: 1n, attestor, specHash: SPEC, judgeFee: 0n });

async function market(world: TestWorld) {
  const [alice, bob, judge, other] = [await world.wallet(), await world.wallet(), await world.wallet(), await world.wallet()];
  const order = { inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT };
  const create = (signer: typeof alice, params: Parameters<typeof world.client.createIntent>[0]["params"]) => world.client.createIntent({ signer, ...order, params });
  const made = {
    swap: await create(alice, swapExactIn({ amountIn: 1_000_000n, minOut: 5n })),
    limit: await create(bob, limitOrder({ makeAmount: 1_000_000n, takeAmount: 5n })),
    judged: await create(alice, proof(judge.address)),
    elsewhere: await create(bob, proof(other.address)),
    cancelled: await create(bob, proof(judge.address)),
  };
  await world.client.cancel(bob, made.cancelled.intent);
  return { alice, bob, judge, other, made };
}

function heard(world: TestWorld): { transport: Transport; queries: (IntentQuery | undefined)[] } {
  const queries: (IntentQuery | undefined)[] = [];
  return {
    queries,
    transport: {
      ...world.transport,
      intents: async (query, read) => {
        queries.push(query);
        return world.transport.intents(query, read);
      },
    },
  };
}

const sorted = (addresses: Address[]) => [...addresses].sort();

describe("intents filters on the node", () => {
  it("returns only the AttestedResult intents of one attestor, and hands the transport the filter", async () => {
    const world = await createTestWorld();
    const { judge, made } = await market(world);
    const { transport, queries } = heard(world);
    const client = createClient({ url: world.client.url, transport });
    const filter = { kind: Kind.AttestedResult, attestor: judge.address };
    expect(sorted((await client.intents(filter)).map(({ address }) => address))).toEqual(sorted([made.judged.intent, made.cancelled.intent]));
    expect(queries).toEqual([filter]);
    expect(sorted((await world.transport.intents(filter)).map(({ address }) => address))).toEqual(sorted([made.judged.intent, made.cancelled.intent]));
    expect((await client.intents({ attestor: judge.address, status: IntentStatus.Open })).map(({ address }) => address)).toEqual([made.judged.intent]);
    expect((await client.intents({ kind: Kind.LimitOrder })).map(({ address }) => address)).toEqual([made.limit.intent]);
  });

  it("combines owner, status, kind and mints", async () => {
    const world = await createTestWorld();
    const { alice, bob, made } = await market(world);
    const of = async (query: IntentQuery) => sorted((await world.client.intents(query)).map(({ address }) => address));
    expect(await of({ owner: alice.address })).toEqual(sorted([made.swap.intent, made.judged.intent]));
    expect(await of({ owner: bob.address, status: IntentStatus.Cancelled })).toEqual([made.cancelled.intent]);
    expect(await of({ owner: bob.address, kind: Kind.AttestedResult, status: IntentStatus.Open })).toEqual([made.elsewhere.intent]);
    expect(await of({ inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT, kind: Kind.SwapExactIn })).toEqual([made.swap.intent]);
    expect(await of({ outputMint: NATIVE_MINT })).toEqual([]);
  });

  it("refuses a kind, status or attestor no intent can match", async () => {
    const world = await createTestWorld();
    await expect(world.client.intents({ kind: 9 })).rejects.toMatchObject({ field: "kind", rule: "range" });
    await expect(world.client.intents({ status: 7 })).rejects.toMatchObject({ field: "status", rule: "range" });
    await expect(world.client.intents({ owner: "nope" as Address })).rejects.toMatchObject({ field: "owner", rule: "format" });
    await expect(world.client.intents({ kind: Kind.SwapExactIn, attestor: world.admin.address })).rejects.toMatchObject({ field: "attestor", rule: "conflict", message: ATTESTOR_NEEDS_ATTESTED });
  });

  it("asks an RPC node for memcmp filters at the offsets the intent layout puts each field", async () => {
    const world = await createTestWorld();
    const { judge, made } = await market(world);
    const stored = await world.client.intent(made.judged.intent);
    if (stored === null) {
      throw new Error("no intent");
    }
    const data = new Uint8Array(getIntentEncoder().encode(stored.intent));
    const at = (offset: number, length: number) => data.subarray(offset, offset + length);
    expect(at(INTENT_OWNER_AT, 32)).toEqual(new Uint8Array(getAddressEncoder().encode(stored.intent.owner)));
    expect(at(INTENT_INPUT_MINT_AT, 32)).toEqual(new Uint8Array(getAddressEncoder().encode(NATIVE_MINT)));
    expect(at(INTENT_OUTPUT_MINT_AT, 32)).toEqual(new Uint8Array(getAddressEncoder().encode(DEVNET_TEST_MINT)));
    expect([...at(INTENT_KIND_AT, 1), ...at(INTENT_STATUS_AT, 1)]).toEqual([Kind.AttestedResult, IntentStatus.Open]);
    expect(at(ATTESTED_ATTESTOR_AT, 32)).toEqual(new Uint8Array(getAddressEncoder().encode(judge.address)));
    expect(getIntentDecoder().decode(data).owner).toBe(stored.intent.owner);

    const asked: unknown[] = [];
    const rpc = {
      getProgramAccounts: (_program: Address, config: { filters: readonly unknown[] }) => ({
        send: async () => {
          asked.push(config.filters);
          return [];
        },
      }),
    } as unknown as RpcLike;
    await rpcTransport(rpc).intents({ owner: stored.intent.owner, status: IntentStatus.Open, kind: Kind.AttestedResult, inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT, attestor: judge.address });
    const memcmp = (offset: number, bytes: string) => ({ memcmp: { offset: BigInt(offset), bytes, encoding: "base58" } });
    expect((asked[0] as unknown[]).slice(2)).toEqual([
      memcmp(INTENT_OWNER_AT, stored.intent.owner),
      memcmp(INTENT_INPUT_MINT_AT, NATIVE_MINT),
      memcmp(INTENT_OUTPUT_MINT_AT, DEVNET_TEST_MINT),
      memcmp(INTENT_KIND_AT, getBase58Decoder().decode(Uint8Array.of(Kind.AttestedResult))),
      memcmp(INTENT_STATUS_AT, getBase58Decoder().decode(Uint8Array.of(IntentStatus.Open))),
      memcmp(ATTESTED_ATTESTOR_AT, judge.address),
    ]);
    await rpcTransport(rpc).intents({ attestor: judge.address });
    expect((asked[1] as unknown[]).slice(2)).toEqual([memcmp(INTENT_KIND_AT, getBase58Decoder().decode(Uint8Array.of(Kind.AttestedResult))), memcmp(ATTESTED_ATTESTOR_AT, judge.address)]);
  });
});
