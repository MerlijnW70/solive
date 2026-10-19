export type Rent = { perByteYear: bigint; threshold: number };

export const MIN_RENT_PER_BYTE = 696;

export const MAX_RENT_PER_BYTE = 6_960;

export const CONSERVATIVE_RENT: Rent = { perByteYear: 3_480n, threshold: 2 };

const ACCOUNT_STORAGE_OVERHEAD = 128n;

export class UnsupportedRent extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedRent";
  }
}

export const unsupportedRent = (rate: number): string =>
  `the cluster charges ${rate} lamports of rent per byte; this client prices rent only from ${MIN_RENT_PER_BYTE} to ${MAX_RENT_PER_BYTE}`;

export const unsupportedThreshold = (threshold: number): string =>
  `the cluster's rent sysvar reports an exemption threshold of ${threshold}; this client prices rent only with a positive finite threshold`;

export function checkedRent(rent: Rent): Rent {
  if (!Number.isFinite(rent.threshold) || rent.threshold <= 0) {
    throw new UnsupportedRent(unsupportedThreshold(rent.threshold));
  }
  const rate = Number(rent.perByteYear) * rent.threshold;
  if (!(rate >= MIN_RENT_PER_BYTE && rate <= MAX_RENT_PER_BYTE)) {
    throw new UnsupportedRent(unsupportedRent(rate));
  }
  return rent;
}

export const rentExemptAt = (space: number, rent: Rent): bigint =>
  BigInt(Math.floor(Number(rent.perByteYear * (ACCOUNT_STORAGE_OVERHEAD + BigInt(space))) * rent.threshold));

export const chainRent = async (chain: { rent?(): Promise<Rent> }): Promise<Rent> =>
  chain.rent === undefined ? CONSERVATIVE_RENT : checkedRent(await chain.rent());
