import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type Lookup = (host: string) => Promise<string[]>;

export const systemLookup: Lookup = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((found) => found.address);

const V4_PRIVATE: readonly [number, number][] = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0000200, 24],
  [0xc0a80000, 16],
  [0xc6120000, 15],
  [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 4],
  [0xf0000000, 4],
];

function v4Number(ip: string): number | null {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return null;
  }
  return parts.reduce((n, p) => n * 256 + p, 0);
}

function privateV4(ip: string): boolean {
  const n = v4Number(ip);
  if (n === null) {
    return true;
  }
  return V4_PRIVATE.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
}

function v6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  let extra: number[] = [];
  if (tail !== null) {
    const n = v4Number(tail[1] ?? "");
    if (n === null) {
      return null;
    }
    extra = [Math.floor(n / 65536), n % 65536];
    text = text.slice(0, -(tail[1] ?? "").length);
    if (!text.endsWith("::")) {
      text = text.replace(/:$/, "");
    }
  }
  const halves = text.split("::");
  if (halves.length > 2) {
    return null;
  }
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((g) => Number.parseInt(g, 16)));
  const head = parse(halves[0] ?? "");
  const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
  const known = head.length + rest.length + extra.length;
  if (halves.length === 1 && known !== 8) {
    return null;
  }
  const groups = [...head, ...new Array(halves.length === 2 ? 8 - known : 0).fill(0), ...rest, ...extra];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

const embedded = (high: number, low: number): string => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;

function privateV6(ip: string): boolean {
  const g = v6Groups(ip);
  if (g === null) {
    return true;
  }
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, x = 0, y = 0] = g;
  if (g.slice(0, 5).every((v) => v === 0) && f === 0xffff) {
    return privateV4(embedded(x, y));
  }
  if (g.slice(0, 6).every((v) => v === 0) || (g.slice(0, 4).every((v) => v === 0) && e === 0xffff && f === 0)) {
    return true;
  }
  if (a === 0x2002) {
    return privateV4(embedded(b, c));
  }
  if (a === 0x2001 && b === 0) {
    return privateV4(embedded(c, d)) || privateV4(embedded(x ^ 0xffff, y ^ 0xffff));
  }
  return (a & 0xfe00) === 0xfc00 || (a & 0xffc0) === 0xfe80 || (a & 0xffc0) === 0xfec0 || (a & 0xff00) === 0xff00 || (a === 0x2001 && b === 0x0db8) || (a === 0x0064 && b === 0xff9b);
}

export function privateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    return privateV4(ip);
  }
  if (family === 6) {
    return privateV6(ip);
  }
  return true;
}

export async function publicAddresses(hostname: string, lookup: Lookup): Promise<string[] | null> {
  const host = hostname.replace(/^\[/, "").replace(/\]$/, "");
  let addresses: string[];
  try {
    addresses = isIP(host) === 0 ? await lookup(host) : [host];
  } catch {
    return null;
  }
  return addresses.length > 0 && !addresses.some(privateAddress) ? addresses : null;
}

export async function publicHost(hostname: string, lookup: Lookup): Promise<boolean> {
  return (await publicAddresses(hostname, lookup)) !== null;
}
