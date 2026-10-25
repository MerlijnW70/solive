import {
  type Address,
  type Base64EncodedWireTransaction,
  type Blockhash,
  generateKeyPairSigner,
  getSolanaErrorFromJsonRpcError,
  isSolanaError,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  MaybeSent,
  behindMinSlot,
  heardSlot,
  MIN_CONTEXT_SLOT_NOT_REACHED,
  memoized,
  MULTIPLE_ACCOUNTS_LIMIT,
  POLL_MS,
  RATE_LIMIT_ATTEMPTS,
  type RpcLike,
  type Transport,
  rpcTransport,
  FailedOnChain,
} from "../src/transport.js";
import { isolateMocks, OTHER, OWNER, SIG, stub, TOKEN_PROGRAM } from "./transport-stub.js";

isolateMocks();

const OWNER_TWO = "11111111111111111111111111111113" as Address;
const OTHER_TWO = "11111111111111111111111111111114" as Address;

describe("account reads", () => {
  it("fetches many accounts in calls of at most the limit the RPC allows", async () => {
    const s = stub([]);
    const addresses = Array.from({ length: MULTIPLE_ACCOUNTS_LIMIT + 1 }, (_, i) => (i === 0 ? OWNER : OTHER));
    const views = await rpcTransport(s.rpc as unknown as RpcLike).getAccounts(addresses);
    expect(views).toHaveLength(MULTIPLE_ACCOUNTS_LIMIT + 1);
    expect(views[0]).toEqual({ owner: OWNER, data: new Uint8Array([1, 2, 3]), lamports: 7n, executable: true });
    expect(views[1]).toBeNull();
    expect(s.calls.filter((c) => c.startsWith("many:"))).toEqual([`many:${MULTIPLE_ACCOUNTS_LIMIT}`, "many:1"]);
  });

  it("reads each account once per call, fetches the missing ones together, and never keeps a failed read", async () => {
    const singles: Address[] = [];
    const batches: Address[][] = [];
    let failing = true;
    const inner = {
      getAccount: async (address: Address) => {
        singles.push(address);
        if (failing && address === TOKEN_PROGRAM) {
          throw new Error("rpc down");
        }
        return null;
      },
      getAccounts: async (addresses: readonly Address[]) => {
        batches.push([...addresses]);
        return addresses.map(() => null);
      },
    } as unknown as Transport;
    const reading = memoized(inner);
    expect(memoized(reading)).toBe(reading);
    await reading.warm?.([OWNER, OTHER, OWNER]);
    await reading.warm?.([OWNER, OTHER]);
    await Promise.all([reading.getAccount(OWNER), reading.getAccount(OTHER), reading.getAccount(OTHER)]);
    expect(await reading.getAccounts([OWNER, OTHER])).toEqual([null, null]);
    expect(await reading.getAccounts([OWNER, OWNER_TWO, OTHER_TWO])).toEqual([null, null, null]);
    expect([batches, singles]).toEqual([[[OWNER, OTHER], [OWNER_TWO, OTHER_TWO]], []]);
    await expect(reading.getAccount(TOKEN_PROGRAM)).rejects.toThrow("rpc down");
    failing = false;
    expect(await reading.getAccount(TOKEN_PROGRAM)).toBeNull();
    expect(await reading.getAccount(TOKEN_PROGRAM)).toBeNull();
    expect(singles).toEqual([TOKEN_PROGRAM, TOKEN_PROGRAM]);
  });

  it("forgets every read once anything is sent, so a read after a write sees the new state", async () => {
    let lamports = 0n;
    const reads: Address[] = [];
    const inner = {
      getAccount: async (address: Address) => {
        reads.push(address);
        return { owner: OWNER, data: new Uint8Array(), lamports, executable: false };
      },
      getAccounts: async () => [],
      airdrop: async () => {
        lamports = 5n;
        return "airdropped";
      },
      sendWire: async () => {
        lamports = 9n;
        return "sent";
      },
    } as unknown as Transport;
    const reading = memoized(inner);
    expect((await reading.getAccount(OWNER))?.lamports).toBe(0n);
    expect((await reading.getAccount(OWNER))?.lamports).toBe(0n);
    await reading.airdrop(OWNER, 5n);
    expect((await reading.getAccount(OWNER))?.lamports).toBe(5n);
    await reading.sendWire("w" as never, { blockhash: "" as Blockhash, lastValidBlockHeight: 0n });
    expect((await reading.getAccount(OWNER))?.lamports).toBe(9n);
    expect(reads).toHaveLength(3);
  });
});

describe("read your writes", () => {
  const behind = () =>
    getSolanaErrorFromJsonRpcError({ code: -32016, message: "Minimum context slot has not been reached", data: { contextSlot: 5 } });

  function recording(confirmedAt: bigint[], refusals = 0) {
    const s = stub([]);
    const seen: [string, bigint | undefined][] = [];
    let refuse = refusals;
    const note = (call: string, config: { minContextSlot?: bigint }) => {
      seen.push([call, "minContextSlot" in config ? config.minContextSlot : undefined]);
      if (refuse > 0) {
        refuse -= 1;
        throw behind();
      }
    };
    const rpc = {
      ...s.rpc,
      getSignatureStatuses: () => ({
        send: async () => {
          const slot = confirmedAt.shift();
          return {
            context: { slot: 1_000_000n },
            value: [slot === undefined ? null : { err: null, confirmationStatus: "confirmed", slot }],
          };
        },
      }),
      getAccountInfo: (_address: Address, config: { encoding: "base64"; minContextSlot?: bigint }) => ({
        send: async () => {
          note("account", config);
          return { value: null };
        },
      }),
      getMultipleAccounts: (addresses: Address[], config: { encoding: "base64"; minContextSlot?: bigint }) => ({
        send: async () => {
          note("accounts", config);
          return { value: addresses.map(() => null) };
        },
      }),
      getProgramAccounts: (_program: Address, config: { minContextSlot?: bigint }) => ({
        send: async () => {
          note("program", config);
          return [];
        },
      }),
      getSignaturesForAddress: (_address: Address, config: { limit: number; minContextSlot?: bigint }) => ({
        send: async () => {
          note("signatures", config);
          return [];
        },
      }),
    } satisfies RpcLike;
    return { rpc, seen, waits: s.waits, wait: s.wait };
  }

  const readAll = async (t: Transport) => {
    await t.getAccount(OWNER);
    await t.getAccounts([OWNER, OTHER]);
    await t.intents();
    await t.engineTransactions(3, OWNER);
  };

  it("reads with no minimum slot before any send of its own has confirmed", async () => {
    const r = recording([]);
    await readAll(rpcTransport(r.rpc, r.wait));
    expect(r.seen).toEqual([
      ["account", undefined],
      ["accounts", undefined],
      ["program", undefined],
      ["signatures", undefined],
    ]);
  });

  it("takes the slot from the polled signature status and reads at least there, never going back", async () => {
    const r = recording([4_242n, 4_000n, 5_000n]);
    const t = rpcTransport(r.rpc, r.wait);
    const payer = await generateKeyPairSigner();
    await t.send([], payer);
    await readAll(t);
    expect(r.seen).toEqual([
      ["account", 4_242n],
      ["accounts", 4_242n],
      ["program", 4_242n],
      ["signatures", 4_242n],
    ]);
    await t.sendWire("w" as Base64EncodedWireTransaction, { blockhash: "" as Blockhash, lastValidBlockHeight: 10n });
    await t.getAccount(OWNER);
    await t.airdrop(OWNER, 1n);
    await t.getAccount(OWNER);
    expect(r.seen.slice(4)).toEqual([
      ["account", 4_242n],
      ["account", 5_000n],
    ]);
  });

  it("takes the slot from the signature notification when the subscription confirms first", async () => {
    const r = recording([]);
    const slow = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms > 0 ? 20 : 0));
    const t = rpcTransport(r.rpc, slow, async (signature) => heardSlot(signature, { context: { slot: 77n }, value: { err: null } }));
    await t.sendWire("w" as Base64EncodedWireTransaction, { blockhash: "" as Blockhash, lastValidBlockHeight: 10n });
    await t.getAccount(OWNER);
    expect(r.seen).toEqual([["account", 77n]]);
    expect(heardSlot(SIG, { value: { err: null } })).toEqual({});
    expect(() => heardSlot(SIG, { context: { slot: 1n }, value: { err: "boom" } })).toThrow(FailedOnChain);
  });

  it("retries a node that has not reached the minimum context slot, with backoff", async () => {
    expect(behindMinSlot(behind())).toBe(true);
    expect(behindMinSlot(new Error("JSON-RPC error -32016: Minimum context slot has not been reached"))).toBe(true);
    expect(behindMinSlot(new Error("HTTP error (500): boom"))).toBe(false);
    expect(behindMinSlot(new MaybeSent(SIG, 10n, "Minimum context slot has not been reached"))).toBe(false);
    expect(MIN_CONTEXT_SLOT_NOT_REACHED).toBe(-32016);
    const r = recording([9n], 2);
    const t = rpcTransport(r.rpc, r.wait);
    await t.send([], await generateKeyPairSigner());
    expect(await t.getAccount(OWNER)).toBeNull();
    expect(r.seen).toEqual([
      ["account", 9n],
      ["account", 9n],
      ["account", 9n],
    ]);
    expect(r.waits).toEqual([2 * POLL_MS, 4 * POLL_MS]);
  });

  it("gives up with the node's own error once the retries run out", async () => {
    const r = recording([9n], RATE_LIMIT_ATTEMPTS);
    const t = rpcTransport(r.rpc, r.wait);
    await t.send([], await generateKeyPairSigner());
    const failed = await t.intents().catch((error: unknown) => error);
    expect(behindMinSlot(failed)).toBe(true);
    expect(isSolanaError(failed, MIN_CONTEXT_SLOT_NOT_REACHED)).toBe(true);
    expect(r.seen).toHaveLength(RATE_LIMIT_ATTEMPTS);
  });
});
