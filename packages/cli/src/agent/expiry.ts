import { formatTime } from "@intent-engine/core/internal";

const UNITS = [
  ["day", 86_400n],
  ["hour", 3_600n],
  ["minute", 60n],
  ["second", 1n],
] as const;

const counted = (count: bigint, unit: string): string => `${count} ${unit}${count === 1n ? "" : "s"}`;

export function fromNow(at: bigint, now: bigint): string {
  const left = at - now;
  if (left <= 0n) {
    return "already past";
  }
  const first = UNITS.findIndex(([, size]) => left >= size);
  const [unit, size] = UNITS[first] ?? UNITS[3];
  const next = UNITS[first + 1];
  const rest = next === undefined ? 0n : (left % size) / next[1];
  return `${[counted(left / size, unit), ...(next === undefined || rest === 0n ? [] : [counted(rest, next[0])])].join(" ")} from now`;
}

export const whenFromNow = (at: bigint, now: bigint): string => `${formatTime(at)}, ${fromNow(at, now)}`;

export const expiresLine = (at: bigint, now: bigint): string => `Expires: ${whenFromNow(at, now)}`;

export const withFromNow = (lines: readonly string[], at: bigint, now: bigint): string[] =>
  lines.map((line) => (line === `Expires: ${formatTime(at)}` ? expiresLine(at, now) : line));
