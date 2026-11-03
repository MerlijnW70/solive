import { type Address, generateKeyPairSigner, getAddressEncoder, getBase58Decoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { attestedResult, DEVNET_TEST_MINT, IntentStatus, Kind, limitOrder, NATIVE_MINT, swapExactIn } from "@intent-engine/core";
import { getIntentDiscriminatorBytes, getIntentSize } from "@intent-engine/core/internal";
import type { IntentQuery } from "../src/index.js";
import {
  ATTESTED_ATTESTOR_AT,
  INTENT_INPUT_MINT_AT,
  INTENT_KIND_AT,
  INTENT_OUTPUT_MINT_AT,
  INTENT_OWNER_AT,
  INTENT_STATUS_AT,
  NODE_FILTER_LIMIT,
  planFilters,
  rpcTransport,
  type RpcLike,
} from "../src/internal.js";
import { createTestWorld } from "../src/testing.js";
import { donorsOf, expectedFor, fieldCount, queryShapes } from "./intent-shapes.js";
import { SPEC } from "./plan-driver.js";
import { stockNode, TOO_MANY_FILTERS } from "./stock-node.js";

const encoded = (address: Address): Uint8Array => Uint8Array.from(getAddressEncoder().encode(address));
const STATUSES: number[] = Object.values(IntentStatus);

async function mixedSet() {
  const world = await createTestWorld();
  const [alice, bob, judge] = [await world.wallet(), await world.wallet(), await world.wallet()];
  const order = { inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT };
  const proof = (attestor: Address) => attestedResult({ amountIn: 1_000_000n, minResult: 1n, maxResult: 1n, attestor, specHash: SPEC, judgeFee: 0n });
  await world.client.createIntent({ signer: alice, ...order, params: swapExactIn({ amountIn: 1_000_000n, minOut: 5n }) });
  await world.client.createIntent({ signer: bob, ...order, params: limitOrder({ makeAmount: 1_000_000n, takeAmount: 5n }) });
  await world.client.createIntent({ signer: alice, ...order, params: proof(judge.address) });
  const bases = await world.transport.intents();
  const owners = [alice.address, bob.address, judge.address];
  const mints = [NATIVE_MINT, DEVNET_TEST_MINT, await world.mint()];
  const judges = [judge.address, bob.address];
  const accounts: { address: Address; data: Uint8Array }[] = [];
  for (const base of bases) {
    for (const [o, owner] of owners.entries()) {
      for (const [m, mint] of mints.entries()) {
        for (const status of STATUSES.slice(0, 3)) {
          for (const attestor of judges) {
            const data = Uint8Array.from(base.data);
            data.set(encoded(owner), INTENT_OWNER_AT);
            data.set(encoded(mint), INTENT_INPUT_MINT_AT);
            data.set(encoded(mints[(m + o) % mints.length] ?? mint), INTENT_OUTPUT_MINT_AT);
            data[INTENT_STATUS_AT] = status;
            if (data[INTENT_KIND_AT] === Kind.AttestedResult) {
              data.set(encoded(attestor), ATTESTED_ATTESTOR_AT);
            }
            accounts.push({ address: (await generateKeyPairSigner()).address, data });
          }
        }
      }
    }
  }
  return { accounts, elsewhere: (await generateKeyPairSigner()).address };
}

describe("intent reads on a node that refuses more than four filters", () => {
  it("sends at most four filters for every combination of the query fields and returns what a full client-side check returns", { timeout: 120_000 }, async () => {
    const { accounts, elsewhere } = await mixedSet();
    const donors = donorsOf(accounts, elsewhere);
    const shapes = queryShapes(donors.filter((_, at) => at % 23 === 0));
    expect(shapes.length).toBeGreaterThan(300);
    expect(new Set(shapes.map(fieldCount))).toEqual(new Set([0, 1, 2, 3, 4, 5, 6]));
    const node = stockNode(accounts.map(({ address, data }) => ({ pubkey: address, data })));
    const transport = rpcTransport(node.rpc as unknown as RpcLike);
    let nonEmpty = 0;
    for (const shape of shapes) {
      const found = (await transport.intents(shape)).map(({ address }) => address).sort();
      const want = expectedFor(accounts, shape).sort();
      expect(found, JSON.stringify(shape)).toEqual(want);
      nonEmpty += want.length > 0 ? 1 : 0;
    }
    expect(nonEmpty).toBeGreaterThan(100);
    expect(node.asked.length).toBe(shapes.length);
    expect(Math.max(...node.asked.map((filters) => filters.length))).toBeLessThanOrEqual(NODE_FILTER_LIMIT);
  });

  it("returns the same accounts for engine account filters that carry more matches than fit", async () => {
    const { accounts } = await mixedSet();
    const node = stockNode(accounts.map(({ address, data }) => ({ pubkey: address, data })));
    const transport = rpcTransport(node.rpc as unknown as RpcLike);
    const sample = accounts.find(({ data }) => data[INTENT_KIND_AT] === Kind.AttestedResult);
    if (sample === undefined) {
      throw new Error("no attested intent");
    }
    const at = (offset: number, length: number) => sample.data.slice(offset, offset + length);
    const match = [
      { offset: INTENT_OWNER_AT, bytes: at(INTENT_OWNER_AT, 32) },
      { offset: INTENT_INPUT_MINT_AT, bytes: at(INTENT_INPUT_MINT_AT, 32) },
      { offset: INTENT_OUTPUT_MINT_AT, bytes: at(INTENT_OUTPUT_MINT_AT, 32) },
      { offset: INTENT_KIND_AT, bytes: at(INTENT_KIND_AT, 2) },
      { offset: ATTESTED_ATTESTOR_AT, bytes: at(ATTESTED_ATTESTOR_AT, 32) },
    ];
    const filter = { discriminator: getIntentDiscriminatorBytes(), dataSize: getIntentSize(), match };
    const holds = (data: Uint8Array) => match.every((m) => m.bytes.every((byte, i) => data[m.offset + i] === byte));
    const found = ((await transport.engineAccounts?.(filter)) ?? []).map(({ address }) => address).sort();
    expect(found.length).toBeGreaterThan(0);
    expect(found).toEqual(accounts.filter(({ data }) => holds(data)).map(({ address }) => address).sort());
    expect(node.asked.every((filters) => filters.length <= NODE_FILTER_LIMIT)).toBe(true);
  });

  it("merges kind and status into one memcmp that matches only that kind with that status", async () => {
    const owner = await generateKeyPairSigner();
    const plan = planFilters({
      discriminator: getIntentDiscriminatorBytes(),
      dataSize: getIntentSize(),
      match: [
        { offset: INTENT_INPUT_MINT_AT, address: NATIVE_MINT },
        { offset: INTENT_KIND_AT, bytes: Uint8Array.of(Kind.AttestedResult) },
        { offset: INTENT_STATUS_AT, bytes: Uint8Array.of(IntentStatus.Open) },
      ],
    });
    expect(plan.filters).toHaveLength(NODE_FILTER_LIMIT);
    expect(plan.filters[3]).toEqual({
      memcmp: { offset: BigInt(INTENT_KIND_AT), bytes: getBase58Decoder().decode(Uint8Array.of(Kind.AttestedResult, IntentStatus.Open)), encoding: "base58" },
    });
    const sized = getIntentSize();
    const account = (kind: number, status: number) => {
      const data = new Uint8Array(sized);
      data.set(getIntentDiscriminatorBytes(), 0);
      data.set(encoded(owner.address), INTENT_OWNER_AT);
      data.set(encoded(NATIVE_MINT), INTENT_INPUT_MINT_AT);
      data[INTENT_KIND_AT] = kind;
      data[INTENT_STATUS_AT] = status;
      return data;
    };
    const wrongStatus = STATUSES.find((status) => status !== IntentStatus.Open) ?? 0;
    const wrongKind = Kind.SwapExactIn;
    const node = stockNode([
      { pubkey: "11111111111111111111111111111112" as Address, data: account(Kind.AttestedResult, IntentStatus.Open) },
      { pubkey: "11111111111111111111111111111113" as Address, data: account(Kind.AttestedResult, wrongStatus) },
      { pubkey: "11111111111111111111111111111114" as Address, data: account(wrongKind, IntentStatus.Open) },
      { pubkey: "11111111111111111111111111111115" as Address, data: account(wrongKind, wrongStatus) },
    ]);
    const transport = rpcTransport(node.rpc as unknown as RpcLike);
    const found = await transport.intents({ inputMint: NATIVE_MINT, kind: Kind.AttestedResult, status: IntentStatus.Open } satisfies IntentQuery);
    expect(found.map(({ address }) => address)).toEqual(["11111111111111111111111111111112"]);
    expect(node.asked[0]).toHaveLength(NODE_FILTER_LIMIT);
  });

  it("sends the most selective fields to the node and leaves kind and status to the client when not all fit", async () => {
    const sent = async (query: IntentQuery) => {
      const node = stockNode([]);
      await rpcTransport(node.rpc as unknown as RpcLike).intents(query);
      return (node.asked[0] ?? []).slice(2).map((filter) => ("memcmp" in filter ? Number(filter.memcmp.offset) : -1));
    };
    expect(await sent({ owner: NATIVE_MINT, status: IntentStatus.Open, kind: Kind.AttestedResult, outputMint: DEVNET_TEST_MINT, attestor: DEVNET_TEST_MINT })).toEqual([
      INTENT_OWNER_AT,
      ATTESTED_ATTESTOR_AT,
    ]);
    expect(await sent({ owner: NATIVE_MINT, status: IntentStatus.Open, kind: Kind.AttestedResult, inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT, attestor: DEVNET_TEST_MINT })).toEqual([
      INTENT_OWNER_AT,
      ATTESTED_ATTESTOR_AT,
    ]);
    expect(await sent({ status: IntentStatus.Open, kind: Kind.SwapExactIn, inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT })).toEqual([INTENT_INPUT_MINT_AT, INTENT_KIND_AT]);
  });
});

describe("the fake node", () => {
  it("refuses a fifth filter and answers four", async () => {
    const node = stockNode([]);
    const ask = (count: number) =>
      node.rpc
        .getProgramAccounts("11111111111111111111111111111112" as Address, { filters: Array.from({ length: count }, () => ({ dataSize: 1n })) })
        .send();
    await expect(ask(5)).rejects.toThrow(TOO_MANY_FILTERS);
    await expect(ask(4)).resolves.toEqual([]);
  });
});
