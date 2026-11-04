import { DEVNET_URL } from "../tokens.js";

const ELSEWHERE: readonly (readonly [string, string])[] = [
  ["SOL, TEST or a token mint address", "SOL or a token mint address"],
  ["SOL, TEST or a mint address", "SOL or a mint address"],
  ["SOL, TEST or the mint", "SOL or the mint"],
  [" and, on devnet, the TEST token", ""],
  [", or TEST when selling SOL on devnet", ""],
  ["a reminder, on devnet only, of where devnet SOL shows", "a reminder of where the wallet's SOL shows, when the cluster needs one"],
  ["SOL and TEST first, then", "SOL first, then"],
  ["escrows in TEST or other mints", "escrows in other mints"],
];

export const forCluster = (text: string, url: string | undefined): string =>
  url === undefined || url === DEVNET_URL ? text : ELSEWHERE.reduce((made, [devnet, elsewhere]) => made.replaceAll(devnet, elsewhere), text);

export const schemaForCluster = (json: unknown, url: string | undefined): unknown => {
  if (url === undefined || url === DEVNET_URL) {
    return json;
  }
  if (Array.isArray(json)) {
    return json.map((item) => schemaForCluster(item, url));
  }
  if (typeof json !== "object" || json === null) {
    return json;
  }
  return Object.fromEntries(
    Object.entries(json).map(([key, value]) => [key, key === "description" && typeof value === "string" ? forCluster(value, url) : schemaForCluster(value, url)]),
  );
};
