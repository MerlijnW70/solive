import { describe, expect, it } from "vitest";
import { rpcTransport, type RpcLike } from "../src/transport.js";

type Asked = { blocksFrom: unknown[][]; blocks: unknown[][] };

function node(finalized: readonly bigint[], blockhash: string | null): { rpc: RpcLike; asked: Asked } {
  const asked: Asked = { blocksFrom: [], blocks: [] };
  const rpc = {
    getBlocksWithLimit: (...args: unknown[]) => {
      asked.blocksFrom.push(args);
      return { send: async () => finalized };
    },
    getBlock: (...args: unknown[]) => {
      asked.blocks.push(args);
      return { send: async () => (blockhash === null ? null : { blockhash }) };
    },
  } as unknown as RpcLike;
  return { rpc, asked };
}

describe("rpcTransport finalizedBlock", () => {
  it("reads the first finalized block at or after a slot and its blockhash", async () => {
    const { rpc, asked } = node([107n], "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
    expect(await rpcTransport(rpc).finalizedBlock?.(105n)).toEqual({ slot: 107n, blockhash: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" });
    expect(asked.blocksFrom).toEqual([[105n, 1, { commitment: "finalized" }]]);
    expect(asked.blocks).toEqual([[107n, { commitment: "finalized", encoding: "json", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0 }]]);
  });

  it("answers null while no block at or after the slot is finalized", async () => {
    const { rpc, asked } = node([], "unused");
    expect(await rpcTransport(rpc).finalizedBlock?.(105n)).toBeNull();
    expect(asked.blocks).toEqual([]);
  });

  it("answers null when the node no longer holds the block", async () => {
    const { rpc } = node([107n], null);
    expect(await rpcTransport(rpc).finalizedBlock?.(105n)).toBeNull();
  });

  it("offers no finalized block read on a node that cannot list or read blocks", () => {
    const { rpc } = node([107n], "unused");
    expect(rpcTransport({ ...rpc, getBlock: undefined } as unknown as RpcLike).finalizedBlock).toBeUndefined();
    expect(rpcTransport({ ...rpc, getBlocksWithLimit: undefined } as unknown as RpcLike).finalizedBlock).toBeUndefined();
  });
});
