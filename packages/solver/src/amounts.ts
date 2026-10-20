const ascending = (a: bigint, b: bigint): number => Number(a - b);

export function least(first: bigint, second: bigint): bigint {
  const [low = first] = [first, second].sort(ascending);
  return low;
}

export function most(first: bigint, second: bigint): bigint {
  const [, high = first] = [first, second].sort(ascending);
  return high;
}
