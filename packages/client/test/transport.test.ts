import {
  type Address,
  type Base64EncodedWireTransaction,
  type Blockhash,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64Encoder,
  getSolanaErrorFromJsonRpcError,
  getTransactionDecoder,
  isSolanaError,
  type Signature,
} from "@solana/kit";
import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { getIntentDiscriminatorBytes, getIntentSize, INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core";
import { Charged,
  behindMinSlot,
  heardSlot,
  MIN_CONTEXT_SLOT_NOT_REACHED,
  memoized,
  MULTIPLE_ACCOUNTS_LIMIT,
  changedAccount,
  changesFrom,
  CONFIRM_POLLS,
  confirm,
  confirmSent,
  patiently,
  POLL_MS,
  RATE_LIMIT_ATTEMPTS,
  rateLimited,
  type RpcLike,
  type Transport,
  rpcTransport,
  socketUrl,
  TRANSACTION_FETCHES,
  FailedOnChain,
  BlockhashExpired,
  neverLanded,
  KEPT_TRANSACTIONS,
  MEMO_PROGRAM_ADDRESS,
} from "../src/transport.js";

const SIG = "5".repeat(88) as Signature;
const OWNER = "11111111111111111111111111111112" as Address;
const OTHER = "So11111111111111111111111111111111111111112" as Address;
const OTHER_SIG = "4".repeat(88) as Signature;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

type Status = { err: unknown; confirmationStatus: string | null } | null;

function stub(statuses: Status[], heights: bigint[] = [0n], seen: bigint[] = []) {
  const calls: string[] = [];
  const sent: string[] = [];
  const rpc = {
    getMultipleAccounts: (addresses: Address[]) => ({
      send: async () => {
        calls.push(`many:${addresses.length}`);
        return {
          value: addresses.map((address) =>
            address === OWNER
              ? { owner: OWNER, data: [Buffer.from([1, 2, 3]).toString("base64"), "base64"] as const, lamports: 7n, executable: true }
              : null,
          ),
        };
      },
    }),
    getAccountInfo: (address: Address) => ({
      send: async () => ({
        value:
          address === OWNER
            ? { owner: OWNER, data: [Buffer.from([1, 2, 3]).toString("base64"), "base64"] as const, lamports: 7n, executable: true }
            : null,
      }),
    }),
    getLatestBlockhash: () => ({
      send: async () => ({
        value: { blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 10n },
      }),
    }),
    sendTransaction: (wire: string, config: { encoding: string }) => ({
      send: async () => {
        calls.push(`send:${config.encoding}`);
        sent.push(wire);
        return SIG;
      },
    }),
    simulateTransaction: (
      wire: string,
      config: {
        encoding: string;
        sigVerify: boolean;
        replaceRecentBlockhash: boolean;
        accounts?: { addresses: Address[]; encoding: "base64" };
      },
    ) => ({
      send: async () => {
        calls.push(
          `simulate:${wire}:${config.encoding}:${config.sigVerify}:${config.replaceRecentBlockhash}${config.accounts === undefined ? "" : `:${config.accounts.addresses.join(",")}`}`,
        );
        const accounts = config.accounts?.addresses.map((a, i) =>
          i === 0 ? { data: [Buffer.from([7, 8]).toString("base64"), "base64"] as const } : null,
        );
        return wire === "ok"
          ? { value: { err: null, logs: ["Program log: fine"], unitsConsumed: 1_234n, ...(accounts === undefined ? {} : { accounts }) } }
          : { value: { err: { InstructionError: [1, { Custom: 6010 }] }, logs: null } };
      },
    }),
    getSignatureStatuses: (signatures: Signature[], config?: { searchTransactionHistory: boolean }) => ({
      send: async () => {
        calls.push(`status:${signatures.join(",")}${config?.searchTransactionHistory === true ? ":history" : ""}`);
        return { context: { slot: seen.shift() ?? 1_000_000n }, value: [statuses.shift() ?? null] };
      },
    }),
    getEpochInfo: () => ({
      send: async () => {
        calls.push("epoch");
        const blockHeight = heights.shift() ?? 0n;
        return { blockHeight, absoluteSlot: blockHeight + 100n };
      },
    }),
    getGenesisHash: () => ({ send: async () => "GENESIS" }),
    getRecentPrioritizationFees: (addresses: readonly Address[]) => ({
      send: async () => {
        calls.push(`fees:${addresses.join(",")}`);
        return [{ prioritizationFee: 5n }, { prioritizationFee: 9n }];
      },
    }),
    getSignaturesForAddress: (address: Address, config: { limit: number }) => ({
      send: async () => {
        calls.push(`signatures:${address}:${config.limit}`);
        return [
          { signature: SIG, slot: 7n, blockTime: 100n, err: null },
          { signature: OTHER_SIG, slot: 8n, blockTime: null, err: { InstructionError: [0, "x"] } },
        ];
      },
    }),
    getTransaction: (signature: Signature, config: { encoding: string; maxSupportedTransactionVersion: number; commitment: string }) => ({
      send: async () => {
        calls.push(`transaction:${signature}:${config.encoding}:${config.maxSupportedTransactionVersion}:${config.commitment}`);
        return signature === SIG
          ? {
              transaction: {
                message: {
                  accountKeys: [OWNER, INTENT_ENGINE_PROGRAM_ADDRESS, MEMO_PROGRAM_ADDRESS],
                  instructions: [
                    { programIdIndex: 2, data: getBase58Decoder().decode(new TextEncoder().encode("delivery note")) },
                    { programIdIndex: 1, data: getBase58Decoder().decode(new TextEncoder().encode("not a memo")) },
                  ],
                },
              },
              meta: {
                loadedAddresses: { writable: [TOKEN_PROGRAM], readonly: [INTENT_ENGINE_PROGRAM_ADDRESS] },
                innerInstructions: [
                  { instructions: [{ programIdIndex: 1, data: getBase58Decoder().decode(new Uint8Array([1, 2])) }] },
                  {
                    instructions: [
                      { programIdIndex: 3, data: getBase58Decoder().decode(new Uint8Array([3])) },
                      { programIdIndex: 4, data: getBase58Decoder().decode(new Uint8Array([4, 5])) },
                      { programIdIndex: 0, data: getBase58Decoder().decode(new Uint8Array([6])) },
                    ],
                  },
                ],
              },
            }
          : null;
      },
    }),
    requestAirdrop: (address: Address, lamports: bigint) => ({
      send: async () => {
        calls.push(`airdrop:${address}:${lamports}`);
        return SIG;
      },
    }),
    getProgramAccounts: (program: Address, config: { encoding: string; filters: readonly unknown[] }) => ({
      send: async () => {
        calls.push(`program-accounts:${program}:${JSON.stringify(config, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v))}`);
        return [{ pubkey: OWNER, account: { data: [Buffer.from([7, 8]).toString("base64"), "base64"] as const } }];
      },
    }),
  } satisfies RpcLike;
  const waits: number[] = [];
  const wait = async (ms: number) => {
    waits.push(ms);
  };
  return { rpc, calls, sent, waits, wait };
}

describe("confirm", () => {
  it("returns at confirmed or finalized and polls in between", async () => {
    const s = stub([null, { err: null, confirmationStatus: "processed" }, { err: null, confirmationStatus: "confirmed" }]);
    await confirm(s.rpc, SIG, 10n, s.wait);
    expect(s.waits).toEqual([POLL_MS, POLL_MS]);
    expect(POLL_MS).toBe(500);
    expect(s.calls.filter((c) => c === `status:${SIG}`)).toHaveLength(3);
    const f = stub([{ err: null, confirmationStatus: "finalized" }]);
    await confirm(f.rpc, SIG, 10n, f.wait);
    expect(f.waits).toEqual([]);
  });

  it("surfaces a failed transaction", async () => {
    const s = stub([{ err: { InstructionError: [0, { Custom: 6008 }] }, confirmationStatus: "confirmed" }]);
    await expect(confirm(s.rpc, SIG, 10n, s.wait)).rejects.toThrow(`transaction ${SIG} failed: { InstructionError: [ 0, { Custom: 6008 } ] }`);
    const again = stub([{ err: { InstructionError: [0, { Custom: 6008 }] }, confirmationStatus: "confirmed" }]);
    const failed = await confirm(again.rpc, SIG, 10n, again.wait).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(Charged);
    expect(failed).toBeInstanceOf(FailedOnChain);
    expect(neverLanded(failed)).toBe(true);
  });

  it("gives up only once the blockhash is past its last valid height", async () => {
    const at = stub([null, null], [10n, 11n]);
    await expect(confirm(at.rpc, SIG, 10n, at.wait)).rejects.toThrow(`transaction ${SIG} expired before confirmation`);
    expect(at.waits).toEqual([POLL_MS]);
    const late = stub([null, null], [10n, 11n]);
    const expired = await confirm(late.rpc, SIG, 10n, late.wait).catch((e: unknown) => e);
    expect(expired).toBeInstanceOf(Error);
    expect(expired).not.toBeInstanceOf(Charged);
    expect(expired).toBeInstanceOf(BlockhashExpired);
    expect(neverLanded(expired)).toBe(true);
  });

  it("looks a transaction up once more before calling it expired, since it may have landed between the two reads", async () => {
    const landed = stub([null, { err: null, confirmationStatus: "confirmed" }], [11n]);
    await confirm(landed.rpc, SIG, 10n, landed.wait);
    expect(landed.calls).toEqual([`status:${SIG}`, "epoch", `status:${SIG}:history`]);
    const failed = await confirm(stub([null, { err: "boom", confirmationStatus: "confirmed" }], [11n]).rpc, SIG, 10n).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(FailedOnChain);
    const pending = await confirm(stub([null, { err: null, confirmationStatus: "processed" }], [11n]).rpc, SIG, 10n).catch((e: unknown) => e);
    expect(pending).toBeInstanceOf(Charged);
    expect(neverLanded(pending)).toBe(false);
  });

  it("calls a transaction expired only on a status read from a node that has seen the block past its last valid height", async () => {
    const lagging = stub([null, null, null, { err: null, confirmationStatus: "confirmed" }], [11n, 11n], [1_000_000n, 50n]);
    await confirm(lagging.rpc, SIG, 10n, lagging.wait);
    expect(lagging.calls).toEqual([`status:${SIG}`, "epoch", `status:${SIG}:history`, `status:${SIG}`, "epoch", `status:${SIG}:history`]);
    const caught = stub([null, null], [11n], [1_000_000n, 111n]);
    await expect(confirm(caught.rpc, SIG, 10n, caught.wait)).rejects.toBeInstanceOf(BlockhashExpired);
    const behind = stub([null, null], [11n], [1_000_000n, 110n]);
    const unsure = await confirm(behind.rpc, SIG, 10n, behind.wait).catch((e: unknown) => e);
    expect(neverLanded(unsure)).toBe(false);
  });

  it("keeps waiting on a failure seen only as processed, since another fork may still land it", async () => {
    const s = stub([{ err: "boom", confirmationStatus: "processed" }, { err: null, confirmationStatus: "confirmed" }]);
    await confirm(s.rpc, SIG, 10n, s.wait);
    const late = await confirm(stub([null, { err: "boom", confirmationStatus: "processed" }], [11n]).rpc, SIG, 10n).catch((e: unknown) => e);
    expect(late).toBeInstanceOf(Charged);
    expect(neverLanded(late)).toBe(false);
  });

  it("says a sent transaction may have landed when its confirmation cannot be read, rather than that it failed", async () => {
    const s = stub([]);
    const throttled = { ...s.rpc, getSignatureStatuses: () => ({ send: async () => Promise.reject(new Error("HTTP error (429): Too Many Requests")) }) };
    const lost = await confirmSent(throttled, SIG, 10n, s.wait).catch((e: unknown) => e);
    expect(lost).toBeInstanceOf(Charged);
    expect(neverLanded(lost)).toBe(false);
    expect(rateLimited(lost)).toBe(false);
    expect((lost as Error).message).toBe(
      `transaction ${SIG} was sent but its confirmation could not be read (HTTP error (429): Too Many Requests); look the signature up before sending again`,
    );
    const failed = await confirmSent(stub([{ err: "boom", confirmationStatus: "confirmed" }]).rpc, SIG, 10n).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(FailedOnChain);
    const expired = await confirmSent(stub([null, null], [11n]).rpc, SIG, 10n).catch((e: unknown) => e);
    expect(expired).toBeInstanceOf(BlockhashExpired);
  });

  it("stops waiting on a node whose block height never moves, and says to look the signature up", async () => {
    expect(CONFIRM_POLLS).toBe(360);
    const stuck = stub([], Array.from({ length: CONFIRM_POLLS + 5 }, () => 5n));
    await expect(confirm(stuck.rpc, SIG, 10n, stuck.wait)).rejects.toThrow(
      `transaction ${SIG} was neither confirmed nor expired after ${CONFIRM_POLLS} checks; the node may be stuck, so look the signature up before sending again`,
    );
    expect(stuck.waits).toHaveLength(CONFIRM_POLLS - 1);
    const still = stub([], Array.from({ length: CONFIRM_POLLS + 5 }, () => 5n));
    const unsure = await confirm(still.rpc, SIG, 10n, still.wait).catch((e: unknown) => e);
    expect(unsure).toBeInstanceOf(Charged);
    expect(neverLanded(unsure)).toBe(false);
    expect(neverLanded(new Error("fetch failed"))).toBe(false);
    expect(stuck.calls.filter((c) => c === `status:${SIG}`)).toHaveLength(CONFIRM_POLLS);
    const late = stub([...Array.from({ length: CONFIRM_POLLS - 1 }, () => null), { err: null, confirmationStatus: "confirmed" }]);
    await confirm(late.rpc, SIG, 10n, late.wait);
    expect(late.waits).toHaveLength(CONFIRM_POLLS - 1);
  });

  it("returns as soon as the signature subscription confirms, and then stops polling", async () => {
    const s = stub([]);
    const slow = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms > 0 ? 20 : 0));
    let aborted = false;
    await confirm(s.rpc, SIG, 10n, slow, async (signature, signal) => {
      expect(signature).toBe(SIG);
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    const polls = s.calls.filter((c) => c === `status:${SIG}`).length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(aborted).toBe(true);
    expect(polls).toBeLessThanOrEqual(1);
    expect(s.calls.filter((c) => c === `status:${SIG}`)).toHaveLength(polls);
  });

  it("surfaces a failure the subscription reports, and falls back to polling when the subscription breaks", async () => {
    const failed = stub([]);
    const slow = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms > 0 ? 20 : 0));
    await expect(
      confirm(failed.rpc, SIG, 10n, slow, async () => {
        throw new Charged(`transaction ${SIG} failed: boom`);
      }),
    ).rejects.toThrow(`transaction ${SIG} failed: boom`);
    const broken = stub([null, { err: null, confirmationStatus: "confirmed" }]);
    await confirm(broken.rpc, SIG, 10n, broken.wait, async () => {
      throw new Error("websocket refused");
    });
    expect(broken.calls.filter((c) => c === `status:${SIG}`)).toHaveLength(2);
  });

  it("waits half a second by default", async () => {
    const s = stub([null, { err: null, confirmationStatus: "confirmed" }]);
    const started = performance.now();
    await confirm(s.rpc, SIG, 10n);
    expect(performance.now() - started).toBeGreaterThanOrEqual(POLL_MS - 50);
  });
});

describe("rpc transport", () => {
  it("asks the node for an airdrop and returns once it confirms", async () => {
    const s = stub([null, { err: null, confirmationStatus: "confirmed" }]);
    const t = rpcTransport(s.rpc, s.wait);
    expect(await t.airdrop(OWNER, 5n)).toBe(SIG);
    expect(s.calls.filter((c) => c.startsWith("airdrop:") || c.startsWith("status:"))).toEqual([
      `airdrop:${OWNER}:5`,
      `status:${SIG}`,
      `status:${SIG}`,
    ]);
  });

  it("simulates without signatures against the latest blockhash and reports the outcome", async () => {
    const s = stub([]);
    const t = rpcTransport(s.rpc, s.wait);
    expect(await t.simulate("ok" as Base64EncodedWireTransaction)).toEqual({
      err: null,
      logs: ["Program log: fine"],
      unitsConsumed: 1_234n,
      accounts: [],
    });
    expect(await t.simulate("bad" as Base64EncodedWireTransaction)).toEqual({
      err: "{ InstructionError: [ 1, { Custom: 6010 } ] }",
      logs: [],
      unitsConsumed: null,
      accounts: [],
    });
    const watched = await t.simulate("ok" as Base64EncodedWireTransaction, [OWNER, OTHER]);
    expect(watched.accounts).toEqual([new Uint8Array([7, 8]), null]);
    expect(s.calls).toEqual([
      "simulate:ok:base64:false:true",
      "simulate:bad:base64:false:true",
      `simulate:ok:base64:false:true:${OWNER},${OTHER}`,
    ]);
  });

  it("decodes base64 account data and reports missing accounts", async () => {
    const t = rpcTransport(stub([]).rpc);
    expect(await t.getAccount(OWNER)).toEqual({ owner: OWNER, data: new Uint8Array([1, 2, 3]), lamports: 7n, executable: true });
    expect(await t.getAccount("So11111111111111111111111111111111111111112" as Address)).toBeNull();
    expect(await t.genesisHash()).toBe("GENESIS");
  });

  it("reads recent priority fees for the named accounts and leaves budgeting to the caller", async () => {
    const s = stub([]);
    const t = rpcTransport(s.rpc, s.wait);
    expect(await t.recentFees([OWNER, TOKEN_PROGRAM])).toEqual([5n, 9n]);
    expect(s.calls).toEqual([`fees:${OWNER},${TOKEN_PROGRAM}`]);
    const ix = { programAddress: OWNER, data: new Uint8Array([1]) };
    expect(await t.budget([ix], OWNER)).toEqual([ix]);
  });

  it("signs with the payer, sends base64 and confirms before returning", async () => {
    const s = stub([{ err: null, confirmationStatus: "confirmed" }]);
    const payer = await generateKeyPairSigner();
    const signature = await rpcTransport(s.rpc, s.wait).send([], payer);
    expect(signature).toBe(SIG);
    expect(s.calls).toEqual(["send:base64", `status:${SIG}`]);
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(s.sent[0] ?? ""));
    expect(Object.keys(tx.signatures)).toEqual([payer.address]);
    expect(tx.signatures[payer.address]).not.toBeNull();
  });
});

describe("rate limits", () => {
  const throttled = () => new Error("HTTP error (429): Too Many Requests");

  it("recognises only a 429 status as rate limiting", () => {
    expect(rateLimited(throttled())).toBe(true);
    expect(rateLimited(new Error("HTTP error (500): boom"))).toBe(false);
    expect(rateLimited(new Error("slot 4290 not found"))).toBe(false);
    expect(rateLimited("429")).toBe(false);
  });

  it("backs off exponentially and returns once a call succeeds", async () => {
    const waits: number[] = [];
    let calls = 0;
    const value = await patiently(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw throttled();
        }
        return "ok";
      },
      async (ms) => {
        waits.push(ms);
      },
    );
    expect(value).toBe("ok");
    expect(waits).toEqual([2 * POLL_MS, 4 * POLL_MS]);
  });

  it("gives up after the last attempt and never retries other failures", async () => {
    expect(RATE_LIMIT_ATTEMPTS).toBe(6);
    const waits: number[] = [];
    let calls = 0;
    await expect(
      patiently(
        async () => {
          calls += 1;
          throw throttled();
        },
        async (ms) => {
          waits.push(ms);
        },
      ),
    ).rejects.toThrow("429");
    expect(calls).toBe(RATE_LIMIT_ATTEMPTS);
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000]);
    let other = 0;
    await expect(
      patiently(async () => {
        other += 1;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(other).toBe(1);
  });

  it("rides out a throttled read inside the transport", async () => {
    const s = stub([]);
    let first = true;
    const rpc = {
      ...s.rpc,
      getAccountInfo: (address: Address) => ({
        send: async () => {
          if (first) {
            first = false;
            throw throttled();
          }
          return s.rpc.getAccountInfo(address).send();
        },
      }),
    } satisfies RpcLike;
    const t = rpcTransport(rpc, s.wait);
    expect(await t.getAccount(OWNER)).toEqual({ owner: OWNER, data: new Uint8Array([1, 2, 3]), lamports: 7n, executable: true });
    expect(s.waits).toEqual([2 * POLL_MS]);
  });
});

describe("intent scan", () => {
  it("asks for engine accounts of the intent size and discriminator at confirmed commitment and decodes them", async () => {
    const s = stub([]);
    const found = await rpcTransport(s.rpc, s.wait).intents();
    expect(found).toEqual([{ address: OWNER, data: new Uint8Array([7, 8]) }]);
    const filters = {
      encoding: "base64",
      commitment: "confirmed",
      filters: [
        { dataSize: getIntentSize().toString() },
        { memcmp: { offset: "0", bytes: getBase58Decoder().decode(getIntentDiscriminatorBytes()), encoding: "base58" } },
      ],
    };
    expect(s.calls).toEqual([`program-accounts:${INTENT_ENGINE_PROGRAM_ADDRESS}:${JSON.stringify(filters)}`]);
    expect(getIntentSize()).toBe(464);
  });
});

describe("engine transactions", () => {
  it("keeps only inner instructions the engine emitted, including through lookup tables", async () => {
    const s = stub([]);
    const transport = rpcTransport(s.rpc, s.wait);
    const found = await transport.engineTransactions(5);
    expect(found).toEqual([
      { signature: SIG, slot: 7n, blockTime: 100n, failed: false, emitted: [new Uint8Array([1, 2]), new Uint8Array([4, 5])], memos: ["delivery note"] },
      { signature: OTHER_SIG, slot: 8n, blockTime: null, failed: true, emitted: [], unread: true },
    ]);
    expect(s.calls).toEqual([
      `signatures:${INTENT_ENGINE_PROGRAM_ADDRESS}:5`,
      `transaction:${SIG}:json:0:confirmed`,
      `transaction:${OTHER_SIG}:json:0:confirmed`,
    ]);
    s.calls.length = 0;
    expect(await transport.engineTransactions(5)).toEqual(found);
    expect(s.calls).toEqual([`signatures:${INTENT_ENGINE_PROGRAM_ADDRESS}:5`, `transaction:${OTHER_SIG}:json:0:confirmed`]);
  });

  it("keeps a bounded number of fetched transactions and fetches only the ones it dropped", async () => {
    const s = stub([]);
    const sigs = Array.from({ length: KEPT_TRANSACTIONS + 1 }, (_, i) => `${SIG.slice(0, -4)}${String(i).padStart(4, "0")}` as Signature);
    const asked: string[] = [];
    const rpc = {
      ...s.rpc,
      getSignaturesForAddress: (_: Address, config: { limit: number }) => ({
        send: async () => sigs.slice(0, config.limit).map((signature, i) => ({ signature, slot: BigInt(i), blockTime: 1n, err: null })),
      }),
      getTransaction: (signature: Signature) => ({
        send: async () => {
          asked.push(signature);
          return { transaction: { message: { accountKeys: [] } }, meta: {} };
        },
      }),
    };
    const transport = rpcTransport(rpc as unknown as typeof s.rpc, s.wait);
    await transport.engineTransactions(sigs.length);
    asked.length = 0;
    await transport.engineTransactions(10);
    expect(asked).toEqual([sigs[0]]);
  });

  it("shares a fetch already under way instead of asking the node twice", async () => {
    const s = stub([]);
    const transport = rpcTransport(s.rpc, s.wait);
    const [first, second] = await Promise.all([transport.engineTransactions(5), transport.engineTransactions(5)]);
    expect(second).toEqual(first);
    expect(s.calls.filter((c) => c.startsWith("transaction:"))).toEqual([
      `transaction:${SIG}:json:0:confirmed`,
      `transaction:${OTHER_SIG}:json:0:confirmed`,
    ]);
  });

  it("fetches again a transaction the node returned without its metadata or block time", async () => {
    const s = stub([]);
    let calls = 0;
    const rpc = {
      ...s.rpc,
      getSignaturesForAddress: () => ({
        send: async () => [
          { signature: SIG, slot: 1n, blockTime: 100n, err: null },
          { signature: OTHER_SIG, slot: 2n, blockTime: null, err: null },
        ],
      }),
      getTransaction: () => ({
        send: async () => {
          calls++;
          return calls === 1 ? { transaction: { message: { accountKeys: [] } }, meta: null } : { transaction: { message: { accountKeys: [] } }, meta: {} };
        },
      }),
    };
    const transport = rpcTransport(rpc as unknown as typeof s.rpc, s.wait);
    await transport.engineTransactions(2);
    await transport.engineTransactions(2);
    await transport.engineTransactions(2);
    expect(calls).toBe(5);
  });

  it("reads one address's transactions when asked, fetching a few at a time and keeping their order", async () => {
    const s = stub([]);
    const sigs = Array.from({ length: TRANSACTION_FETCHES * 2 + 1 }, (_, i) => `${SIG.slice(0, -2)}${String(i).padStart(2, "1")}` as Signature);
    let open = 0;
    let most = 0;
    const rpc = {
      ...s.rpc,
      getSignaturesForAddress: (address: Address, config: { limit: number }) => ({
        send: async () => {
          s.calls.push(`signatures:${address}:${config.limit}`);
          return sigs.map((signature, i) => ({ signature, slot: BigInt(i), blockTime: null, err: null }));
        },
      }),
      getTransaction: () => ({
        send: async () => {
          open++;
          most = Math.max(most, open);
          await new Promise((resolve) => setTimeout(resolve, 1));
          open--;
          return null;
        },
      }),
    };
    const found = await rpcTransport(rpc as unknown as typeof s.rpc, s.wait).engineTransactions(9, OWNER);
    expect(found.map((tx) => tx.signature)).toEqual(sigs);
    expect(s.calls).toEqual([`signatures:${OWNER}:9`]);
    expect(most).toBe(TRANSACTION_FETCHES);
  });
});

describe("intent changes", () => {
  it("opens the websocket the cluster serves next to its RPC", () => {
    expect(socketUrl("https://api.devnet.solana.com")).toBe("wss://api.devnet.solana.com/");
    expect(socketUrl("http://127.0.0.1:8899")).toBe("ws://127.0.0.1:8900/");
    expect(socketUrl("https://rpc.example/key?x=1")).toBe("wss://rpc.example/key?x=1");
  });

  const note = (address: Address, byte: number) => ({
    context: { slot: 1n },
    value: { pubkey: address, account: { data: [Buffer.from([byte]).toString("base64"), "base64"] } },
  });

  it("reads the changed intent out of a notification and ignores anything else", () => {
    expect(changedAccount(note(OWNER, 7))).toEqual({ address: OWNER, data: new Uint8Array([7]) });
    for (const junk of [null, {}, { value: { pubkey: OWNER } }, { value: { pubkey: 1, account: { data: ["", "base64"] } } }]) {
      expect(changedAccount(junk)).toBeNull();
    }
  });

  it("wakes with the intents that changed, keeps only the latest data of each, else wakes empty after the interval", async () => {
    const queue: ((value: IteratorResult<unknown>) => void)[] = [];
    let aborted = false;
    const changes = changesFrom(async (signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>((resolve) => queue.push(resolve)) }) };
    });
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    const push = async (value: unknown) => {
      await flush();
      queue.shift()?.({ value, done: false });
      await flush();
    };
    await flush();
    const started = Date.now();
    const woken = changes.wait(60);
    await push(note(OWNER, 1));
    expect(await woken).toEqual([{ address: OWNER, data: new Uint8Array([1]) }]);
    expect(Date.now() - started).toBeLessThan(1_000);
    await push(note(OTHER, 2));
    await push(note(OTHER, 3));
    await push({ unrelated: true });
    expect(await changes.wait(60)).toEqual([{ address: OTHER, data: new Uint8Array([3]) }]);
    const idle = Date.now();
    expect(await changes.wait(0.05)).toEqual([]);
    expect(Date.now() - idle).toBeGreaterThanOrEqual(40);
    changes.close();
    expect(aborted).toBe(true);
  });

  it("reconnects after the stream fails or ends, waiting longer after each failure and starting over once it hears again", async () => {
    const opened: number[] = [];
    const started = Date.now();
    const streams: (() => AsyncIterable<unknown>)[] = [
      () => {
        throw new Error("refused");
      },
      () => {
        throw new Error("refused again");
      },
      () => ({
        [Symbol.asyncIterator]: () => {
          let sent = false;
          return {
            next: async () => {
              if (sent) {
                return { value: undefined, done: true };
              }
              sent = true;
              return { value: note(OWNER, 9), done: false };
            },
          };
        },
      }),
    ];
    let quiet: (() => void) | undefined;
    let shared: AbortSignal | undefined;
    const changes = changesFrom(async (signal) => {
      shared = signal;
      opened.push(Date.now() - started);
      const stream = streams.shift();
      if (stream !== undefined) {
        return stream();
      }
      return { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>((resolve) => (quiet = () => resolve({ value: undefined, done: true }))) }) };
    }, [20, 60, 1_000]);
    expect(await changes.wait(5)).toEqual([{ address: OWNER, data: new Uint8Array([9]) }]);
    for (let tries = 0; opened.length < 4 && tries < 200; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(opened).toHaveLength(4);
    expect((opened[1] ?? 0) - (opened[0] ?? 0)).toBeGreaterThanOrEqual(15);
    expect((opened[2] ?? 0) - (opened[1] ?? 0)).toBeGreaterThanOrEqual(55);
    expect((opened[3] ?? 0) - (opened[2] ?? 0)).toBeLessThan(500);
    expect(shared === undefined ? -1 : getEventListeners(shared, "abort").length).toBe(0);
    changes.close();
    quiet?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(opened).toHaveLength(4);
  });

  it("falls back to the interval when the websocket cannot be opened", async () => {
    const changes = changesFrom(async () => {
      throw new Error("no websocket");
    });
    const started = Date.now();
    expect(await changes.wait(0.05)).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    changes.close();
  });
});

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
    expect(behindMinSlot(new Charged("Minimum context slot has not been reached"))).toBe(false);
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
