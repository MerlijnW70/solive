import {
  committeeFloors,
  type Config,
  decodeMintCapData,
  getMintCapSize,
  isMintCapData,
  MINT_CAP_DISCRIMINATOR,
} from "@intent-engine/core";
import type { EngineAccountFilter, Transport } from "@intent-engine/client";

export const CAP_LIMITS = ["maxPerOrder", "windowCap", "windowSecs", "totalLimit"] as const;

type CapLimit = (typeof CAP_LIMITS)[number];

export type CapLimits = Record<CapLimit, string | number>;

export type Floors = Record<string, string>;

export type MintCaps = Record<string, CapLimits>;

export const MINT_CAP_FILTER: EngineAccountFilter = { discriminator: MINT_CAP_DISCRIMINATOR, dataSize: getMintCapSize() };

export const NO_FLOOR = "0";

export const CANNOT_LIST = "this connection cannot list program accounts, so the monitor cannot read every mint cap";

const sortedKeys = <T>(record: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

export function floorsOf(config: Pick<Config, "floorMints" | "floorAmounts">): Floors {
  return sortedKeys(Object.fromEntries(committeeFloors(config).map(({ mint, floor }) => [mint, floor.toString()])));
}

export async function mintCapsOf(transport: Transport): Promise<MintCaps> {
  if (transport.engineAccounts === undefined) {
    throw new Error(CANNOT_LIST);
  }
  const caps: MintCaps = {};
  for (const account of await transport.engineAccounts(MINT_CAP_FILTER)) {
    if (!isMintCapData(account.data)) {
      continue;
    }
    const cap = decodeMintCapData(account.data);
    caps[cap.mint] = {
      maxPerOrder: cap.maxPerOrder.toString(),
      windowCap: cap.windowCap.toString(),
      windowSecs: cap.windowSecs,
      totalLimit: cap.totalLimit.toString(),
    };
  }
  return sortedKeys(caps);
}

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const RAW = /^\d+$/;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export function isFloors(v: unknown): v is Floors {
  return isRecord(v) && Object.entries(v).every(([mint, floor]) => ADDRESS.test(mint) && typeof floor === "string" && RAW.test(floor));
}

export function isMintCaps(v: unknown): v is MintCaps {
  return (
    isRecord(v) &&
    Object.entries(v).every(
      ([mint, cap]) =>
        ADDRESS.test(mint) &&
        isRecord(cap) &&
        Object.keys(cap).length === CAP_LIMITS.length &&
        CAP_LIMITS.every((field) => (field === "windowSecs" ? Number.isInteger(cap[field]) : typeof cap[field] === "string" && RAW.test(cap[field] as string))),
    )
  );
}

export type LimitChange = { key: string; kind: "committee-floor" | "mint-cap-limit"; field: string; mint: string; expected: unknown; observed: unknown };

export function floorChanges(baseline: Floors, now: Floors): LimitChange[] {
  const mints = Object.keys(sortedKeys({ ...baseline, ...now }));
  return mints.flatMap((mint) => {
    const expected = baseline[mint] ?? NO_FLOOR;
    const observed = now[mint] ?? NO_FLOOR;
    return expected === observed ? [] : [{ key: `committeeFloor.${mint}`, kind: "committee-floor" as const, field: "floor", mint, expected, observed }];
  });
}

export function capChanges(baseline: MintCaps, now: MintCaps, missing: string): LimitChange[] {
  const mints = Object.keys(sortedKeys({ ...baseline, ...now }));
  return mints.flatMap((mint) =>
    CAP_LIMITS.flatMap((field) => {
      const expected = baseline[mint]?.[field] ?? missing;
      const observed = now[mint]?.[field] ?? missing;
      return expected === observed ? [] : [{ key: `mintCapLimit.${mint}.${field}`, kind: "mint-cap-limit" as const, field, mint, expected, observed }];
    }),
  );
}
