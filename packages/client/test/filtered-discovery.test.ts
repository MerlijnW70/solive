import { type Address, getBase58Decoder, getBase58Encoder } from "@solana/kit";
import { getMintToInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it, vi } from "vitest";
import { findAssociatedTokenAddress, IntentStatus, Kind, NATIVE_MINT } from "@intent-engine/core";
import { getIntentSize, readIntentAccounts } from "@intent-engine/core/internal";
import { connect, createClient, type IntentQuery, type Transport } from "../src/index.js";
import { INTENT_KIND_AT, INTENT_STATUS_AT, intentNotifications, openProofEscrows } from "../src/internal.js";
import { jobsOf } from "../src/jobs.js";
import { world, type World } from "./svm.js";
import { announced, fundedSigner, keyed, LOCAL, nativeMint, sha, specHash } from "./work.js";

const WORK = sha("the filtered work");
const OPEN: IntentQuery = { kind: Kind.AttestedResult, status: IntentStatus.Open };

const captured = vi.hoisted(() => ({ filters: [] as { memcmp?: { offset: bigint; bytes: string }; dataSize?: bigint }[][] }));

vi.mock("@solana/kit", async (original) => ({
  ...(await original<typeof import("@solana/kit")>()),
  createSolanaRpcSubscriptions: () => ({
    programNotifications: (_program: unknown, config: { filters: (typeof captured.filters)[number] }) => {
      captured.filters.push(config.filters);
      return { subscribe: async () => (async function* () {})() };
    },
  }),
}));

async function market() {
  const w: World = await world();
  nativeMint(w);
  const judge = await keyed(w);
  const owner = await fundedSigner(w);
  const client = createClient({ url: LOCAL, transport: w.chain.transport });
  const proof = (nonce: bigint) => ({ signer: owner, nonce, inputMint: NATIVE_MINT, outputMint: w.outputMint, params: { kind: Kind.AttestedResult, amountIn: 1_000_000n, minResult: 1n, maxResult: 1n, attestor: judge.signer.address, specHash: specHash("spec " + nonce), judgeFee: 0n } as const });
  const open = (await client.createIntent(proof(1n))).intent;
  const cancelled = (await client.createIntent(proof(2n))).intent;
  const released = (await client.createIntent(proof(3n))).intent;
  await client.cancel(owner, cancelled);
  const worker = await fundedSigner(w);
  await announced(client, worker, released, WORK);
  const reviewer = await connect({ cluster: "devnet", signer: judge.signer, transport: w.chain.transport });
  await reviewer.release({ escrow: released, deliveredSha256: WORK, keypair: judge.keypair });
  const held = await findAssociatedTokenAddress({ owner: w.owner.address, mint: w.outputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  await w.chain.transport.send([getMintToInstruction({ mint: w.outputMint, token: held, mintAuthority: w.authority, amount: 1_000n })], w.authority);
  const swap = (await client.createIntent({ signer: w.owner, nonce: 4n, inputMint: w.outputMint, outputMint: w.inputMint, params: { kind: Kind.SwapExactIn, amountIn: 100n, minOut: 1n } })).intent;
  const queries: (IntentQuery | undefined)[] = [];
  const counting: Transport = {
    ...w.chain.transport,
    intents: async (query, read) => {
      queries.push(query);
      return w.chain.transport.intents(query, read);
    },
  };
  return { w, open, cancelled, released, swap, queries, counting };
}

describe("open proof escrows are read with the kind and status filters", () => {
  it("asks the transport for AttestedResult intents with status Open only, and lists the same jobs as an unfiltered read", async () => {
    const { w, open, cancelled, released, swap, queries, counting } = await market();
    const every = readIntentAccounts(await w.chain.transport.intents()).intents.map(({ address }) => address);
    expect(every).toEqual(expect.arrayContaining([open, cancelled, released, swap]));
    const { proofs } = await openProofEscrows(counting);
    expect(queries).toEqual([OPEN]);
    expect(proofs.map(({ address }) => address)).toEqual([open]);
    expect((await openProofEscrows(w.chain.transport)).proofs.map(({ address }) => address)).toEqual([open]);
  });

  it("makes the job list, with its pay check, read only filtered intents", async () => {
    const { open, queries, counting } = await market();
    const { jobs } = await jobsOf(counting);
    expect(jobs.map(({ intent }) => intent)).toEqual([open]);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((query) => query?.kind === Kind.AttestedResult && query.status === IntentStatus.Open)).toBe(true);
  });
});

const filtersOf = (kind?: number) => {
  captured.filters.length = 0;
  void intentNotifications("http://127.0.0.1:8899", kind)(new AbortController().signal);
  return captured.filters[0] ?? [];
};

const memcmps = (filters: ReturnType<typeof filtersOf>) => filters.flatMap((filter) => (filter.memcmp === undefined ? [] : [{ offset: Number(filter.memcmp.offset), bytes: filter.memcmp.bytes }]));

describe("intent notifications by kind", () => {
  it("adds a memcmp on the kind byte and never one on the status byte", () => {
    const kind = memcmps(filtersOf(Kind.AttestedResult));
    expect(kind).toContainEqual({ offset: INTENT_KIND_AT, bytes: getBase58Decoder().decode(Uint8Array.of(Kind.AttestedResult)) });
    expect(kind.some(({ offset }) => offset === INTENT_STATUS_AT)).toBe(false);
    expect(memcmps(filtersOf()).some(({ offset }) => offset === INTENT_KIND_AT)).toBe(false);
  });

  it("still matches an escrow after it is released or cancelled, and a status filter would not", async () => {
    const { w, open, cancelled, released, swap } = await market();
    const filters = filtersOf(Kind.AttestedResult);
    const matches = (data: Uint8Array) =>
      filters.every((filter) => {
        if (filter.dataSize !== undefined) {
          return data.length === Number(filter.dataSize);
        }
        const wanted = getBase58Encoder().encode(filter.memcmp?.bytes ?? "");
        const at = Number(filter.memcmp?.offset);
        return wanted.every((byte, i) => data[at + i] === byte);
      });
    const data = async (address: Address) => (await w.chain.transport.getAccount(address))?.data ?? new Uint8Array();
    expect((await data(open)).length).toBe(getIntentSize());
    const statusOf = async (address: Address) => (await data(address))[INTENT_STATUS_AT];
    expect(await statusOf(open)).toBe(IntentStatus.Open);
    expect(await statusOf(cancelled)).toBe(IntentStatus.Cancelled);
    expect(await statusOf(released)).not.toBe(IntentStatus.Open);
    for (const address of [open, cancelled, released]) {
      expect(matches(await data(address)), address).toBe(true);
    }
    expect(matches(await data(swap))).toBe(false);
    const byStatus = (data: Uint8Array) => data[INTENT_STATUS_AT] === IntentStatus.Open;
    expect(byStatus(await data(open))).toBe(true);
    expect(byStatus(await data(cancelled))).toBe(false);
    expect(byStatus(await data(released))).toBe(false);
  });
});
