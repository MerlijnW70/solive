import { type Address, getBase58Encoder } from "@solana/kit";

export const STOCK_NODE_FILTER_LIMIT = 4;
export const TOO_MANY_FILTERS = "Too many filters provided; max 4";

type Filter = { dataSize: bigint } | { memcmp: { offset: bigint; bytes: string; encoding: "base58" } };

export type StoredAccount = { pubkey: Address; data: Uint8Array; lamports?: bigint };

export function refuseTooMany(filters: readonly unknown[]): void {
  if (filters.length > STOCK_NODE_FILTER_LIMIT) {
    throw new Error(TOO_MANY_FILTERS);
  }
}

function checker(filter: Filter): (data: Uint8Array) => boolean {
  if ("dataSize" in filter) {
    return (data) => BigInt(data.length) === filter.dataSize;
  }
  const bytes = getBase58Encoder().encode(filter.memcmp.bytes);
  const at = Number(filter.memcmp.offset);
  return (data) => data.length >= at + bytes.length && bytes.every((b, i) => data[at + i] === b);
}

export function stockNode(stored: readonly StoredAccount[]) {
  const asked: (readonly Filter[])[] = [];
  const rpc = {
    getProgramAccounts: (_program: Address, config: { filters: readonly Filter[]; withContext?: true }) => ({
      send: async () => {
        refuseTooMany(config.filters);
        asked.push(config.filters);
        const checks = config.filters.map(checker);
        const value = stored
          .filter(({ data }) => checks.every((check) => check(data)))
          .map(({ pubkey, data, lamports }) => ({ pubkey, account: { data: [Buffer.from(data).toString("base64"), "base64"] as const, lamports: lamports ?? 1n } }));
        return config.withContext === true ? { context: { slot: 1n }, value } : value;
      },
    }),
  };
  return { rpc, asked };
}
