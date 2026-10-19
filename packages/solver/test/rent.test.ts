import { AccountRole, type Address, type Instruction } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  ASSOCIATED_TOKEN_PROGRAM,
  type Chain,
  chainRent,
  checkedRent,
  CONSERVATIVE_RENT,
  createdRent,
  MAX_RENT_PER_BYTE,
  MIN_RENT_PER_BYTE,
  remembering,
  type Rent,
  rentExempt,
  rentExemptAt,
  TOKEN_ACCOUNT_SPACE,
  UnsupportedRent,
  unsupportedRent,
  unsupportedThreshold,
} from "../src/index.js";

const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const MINT = "So11111111111111111111111111111111111111112" as Address;
const WALLET = "11111111111111111111111111111112" as Address;
const SYSTEM = "11111111111111111111111111111111" as Address;
const DEVNET: Rent = { perByteYear: 5_080n, threshold: 1 };

const createAta = (ata: Address): Instruction => ({
  programAddress: ASSOCIATED_TOKEN_PROGRAM,
  accounts: [WALLET, ata, WALLET, MINT, SYSTEM, TOKEN].map((address) => ({ address, role: AccountRole.READONLY })),
});

const refusal = (rent: Rent): Error => {
  try {
    checkedRent(rent);
  } catch (error) {
    expect(error).toBeInstanceOf(UnsupportedRent);
    return error as Error;
  }
  throw new Error(`accepted ${rent.perByteYear} at ${rent.threshold}`);
};

function chainWith(rent?: () => Promise<Rent>): Chain {
  const unused = async (): Promise<never> => {
    throw new Error("not read");
  };
  return {
    config: unused,
    intents: unused,
    now: unused,
    tokenProgram: unused,
    exists: unused,
    lookupTables: unused,
    blockhash: unused,
    tokenAmount: unused,
    ...(rent === undefined ? {} : { rent }),
  };
}

describe("live rent in the solver", () => {
  it("prices a token account from the rent values the way the runtime does", () => {
    expect(TOKEN_ACCOUNT_SPACE).toBe(165);
    expect(rentExemptAt(165, DEVNET)).toBe(1_488_440n);
    expect(rentExemptAt(165, { perByteYear: 3_387n, threshold: 1.5 })).toBe(1_488_586n);
    expect(rentExemptAt(165, CONSERVATIVE_RENT)).toBe(2_039_280n);
    expect(rentExempt(165)).toBe(2_039_280n);
    expect(rentExempt(170)).toBe(2_074_080n);
    expect(rentExempt(0)).toBe(890_880n);
    expect(CONSERVATIVE_RENT).toEqual({ perByteYear: 3_480n, threshold: 2 });
  });

  it("counts the rent a fill opens at the given rate and at 6960 without one", async () => {
    const first = "SysvarRent111111111111111111111111111111111" as Address;
    const second = "SysvarC1ock11111111111111111111111111111111" as Address;
    const opens = [createAta(first), createAta(second), createAta(first)];
    const missing = async () => false;
    expect(await createdRent(opens, missing)).toBe(4_078_560n);
    expect(await createdRent(opens, missing, async () => null, DEVNET)).toBe(2_976_880n);
    expect(await createdRent(opens, async (account) => account === first, async () => null, DEVNET)).toBe(1_488_440n);
  });

  it("accepts rates from 696 to 6960 and refuses any other rate or threshold with the CLI's messages", () => {
    expect([MIN_RENT_PER_BYTE, MAX_RENT_PER_BYTE]).toEqual([696, 6_960]);
    for (const rent of [
      { perByteYear: 696n, threshold: 1 },
      { perByteYear: 6_960n, threshold: 1 },
      { perByteYear: 464n, threshold: 1.5 },
      { perByteYear: 3_480n, threshold: 2 },
      DEVNET,
    ]) {
      expect(checkedRent(rent)).toBe(rent);
    }
    for (const [perByteYear, threshold, seen] of [
      [695n, 1, "695"],
      [6_961n, 1, "6961"],
      [4_641n, 1.5, "6961.5"],
    ] as const) {
      const message = refusal({ perByteYear, threshold }).message;
      expect(message).toBe(unsupportedRent(Number(seen)));
      expect(message).toBe(`the cluster charges ${seen} lamports of rent per byte; this client prices rent only from 696 to 6960`);
    }
    for (const [threshold, seen] of [
      [Number.NaN, "NaN"],
      [Number.POSITIVE_INFINITY, "Infinity"],
      [0, "0"],
      [-2, "-2"],
    ] as const) {
      const message = refusal({ perByteYear: 3_480n, threshold }).message;
      expect(message).toBe(unsupportedThreshold(threshold));
      expect(message).toBe(
        `the cluster's rent sysvar reports an exemption threshold of ${seen}; this client prices rent only with a positive finite threshold`,
      );
    }
    expect(new UnsupportedRent("x").name).toBe("UnsupportedRent");
  });

  it("reads the chain's rent when it reports one and keeps 6960 when it cannot", async () => {
    expect(await chainRent(chainWith())).toEqual({ perByteYear: 3_480n, threshold: 2 });
    expect(await chainRent(chainWith(async () => DEVNET))).toEqual(DEVNET);
    await expect(chainRent(chainWith(async () => ({ perByteYear: 6_961n, threshold: 1 })))).rejects.toThrow(unsupportedRent(6_961));
    await expect(chainRent(chainWith(async () => ({ perByteYear: 5_080n, threshold: 0 })))).rejects.toBeInstanceOf(UnsupportedRent);
  });

  it("reads the rent once per run, across ticks and forgets, and again only after a failed read", async () => {
    const reads = { count: 0, failing: true };
    const chain = remembering(
      chainWith(async () => {
        reads.count += 1;
        if (reads.failing) {
          throw new Error("rpc down");
        }
        return DEVNET;
      }),
    );
    await expect(chainRent(chain)).rejects.toThrow("rpc down");
    reads.failing = false;
    expect(await chainRent(chain)).toEqual(DEVNET);
    chain.forget();
    expect(await Promise.all([chainRent(chain), chainRent(chain)])).toEqual([DEVNET, DEVNET]);
    expect(reads.count).toBe(2);
    expect(remembering(chainWith())).not.toHaveProperty("rent");
  });
});
