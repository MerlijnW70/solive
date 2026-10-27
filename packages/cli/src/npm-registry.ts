import type { Launched } from "./launch.js";

export type Launch = (program: string, args: readonly string[], timeoutMs?: number) => Promise<Launched | null>;

export const NPM = "npm";
export const REGISTRY_KEY = "registry";
export const SCOPED_REGISTRY_KEY = "@intent-engine:registry";
export const REGISTRY_ARGS: readonly string[] = ["config", "get", REGISTRY_KEY];
export const SCOPED_REGISTRY_ARGS: readonly string[] = ["config", "get", SCOPED_REGISTRY_KEY];
export const REGISTRY_TIMEOUT_MS = 15_000;
export const NPM_REGISTRY = "https://registry.npmjs.org/";
export const useHttps = (key: string) => `npm config set ${key} ${NPM_REGISTRY}`;
export const USE_HTTPS = useHttps(REGISTRY_KEY);
export const ALLOW_HTTP_REGISTRY = "--allow-http-registry";
const REASON_LIMIT = 200;

export type RegistryKey = typeof REGISTRY_KEY | typeof SCOPED_REGISTRY_KEY;

export type Registry =
  | { read: "https"; registry: string }
  | { read: "http"; registry: string; key: RegistryKey }
  | { read: "missing" }
  | { read: "failed"; reason: string };

export const plainRegistry = (registry: string, key: RegistryKey = REGISTRY_KEY) =>
  `npm fetches ${key === REGISTRY_KEY ? "packages" : "@intent-engine packages"} from ${registry} over plain http, so anyone on the network path can change the code it installs; switch npm to https with: ${useHttps(key)}`;

export const httpRefused = (registry: string, key: RegistryKey = REGISTRY_KEY) =>
  `${plainRegistry(registry, key)}, then run this again. Nothing was added; to add the server anyway, pass ${ALLOW_HTTP_REGISTRY}`;

export const NPM_MISSING = "npm was not found, so its registry was not checked; the server starts with npx, which comes with npm";

export const npmFailed = (reason: string) => `npm config get registry failed (${reason}), so its registry was not checked`;

const clipped = (text: string) => (text.length > REASON_LIMIT ? `${text.slice(0, REASON_LIMIT)}...` : text);

type Read = { read: "url"; url: string } | { read: "unset" } | { read: "missing" } | { read: "failed"; reason: string };

async function configUrl(launch: Launch, args: readonly string[]): Promise<Read> {
  let ran: Launched | null;
  try {
    ran = await launch(NPM, args, REGISTRY_TIMEOUT_MS);
  } catch (error) {
    return { read: "failed", reason: clipped(error instanceof Error ? error.message : String(error)) };
  }
  if (ran === null) {
    return { read: "missing" };
  }
  if (ran.code !== 0) {
    return { read: "failed", reason: clipped(`exit ${ran.code}: ${ran.output.trim() === "" ? "it printed nothing" : ran.output.trim()}`) };
  }
  const url = ran.output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\/\S+$/i.test(line))
    .at(-1);
  return url === undefined ? { read: "unset" } : { read: "url", url };
}

const plain = (url: string) => !/^https:/i.test(url);

export async function npmRegistry(launch: Launch): Promise<Registry> {
  const scoped = await configUrl(launch, SCOPED_REGISTRY_ARGS);
  if (scoped.read === "missing" || scoped.read === "failed") {
    return scoped;
  }
  const fallback = await configUrl(launch, REGISTRY_ARGS);
  if (fallback.read === "missing" || fallback.read === "failed") {
    return fallback;
  }
  if (scoped.read === "url" && plain(scoped.url)) {
    return { read: "http", registry: scoped.url, key: SCOPED_REGISTRY_KEY };
  }
  if (fallback.read === "url" && plain(fallback.url)) {
    return { read: "http", registry: fallback.url, key: REGISTRY_KEY };
  }
  if (fallback.read === "unset") {
    return { read: "failed", reason: "it printed no registry url" };
  }
  return { read: "https", registry: scoped.read === "url" ? scoped.url : fallback.url };
}

export function registryWarning(registry: Registry): string | undefined {
  switch (registry.read) {
    case "https":
      return undefined;
    case "http":
      return plainRegistry(registry.registry, registry.key);
    case "missing":
      return NPM_MISSING;
    case "failed":
      return npmFailed(registry.reason);
  }
}
