import { vi } from "vitest";

export type Comparator = (a: unknown, b: unknown) => number;

export async function comparatorsUsedBy(run: () => unknown, field: string): Promise<Comparator[]> {
  const original = Array.prototype.sort;
  const used: Comparator[] = [];
  const spy = vi.spyOn(Array.prototype, "sort").mockImplementation(function (this: unknown[], compare?: Comparator) {
    if (compare !== undefined && compare.toString().includes(`.${field}`)) {
      used.push(compare);
    }
    return original.call(this, compare);
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return used;
}

export function verdicts(compare: Comparator | undefined, make: (position: bigint) => unknown): number[] {
  if (compare === undefined) {
    return [];
  }
  const call = (a: bigint, b: bigint) => compare(make(a), make(b));
  return [call(1n, 2n), call(2n, 1n), call(3n, 3n)];
}
