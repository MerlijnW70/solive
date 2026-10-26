import type { Launched } from "./launch.js";

export type Launch = (program: string, args: readonly string[], timeoutMs?: number) => Promise<Launched | null>;

export const NPM = "npm";
export const REGISTRY_ARGS: readonly string[] = ["config", "get", "registry"];
export const REGISTRY_TIMEOUT_MS = 15_000;
export const NPM_REGISTRY = "https://registry.npmjs.org/";
export const USE_HTTPS = `npm config set registry ${NPM_REGISTRY}`;
export const ALLOW_HTTP_REGISTRY = "--allow-http-registry";
const REASON_LIMIT = 200;

export type Registry = { read: "https" | "http"; registry: string } | { read: "missing" } | { read: "failed"; reason: string };

export const plainRegistry = (registry: string) =>
  `npm fetches packages from ${registry} over plain http, so anyone on the network path can change the code it installs; switch npm to https with: ${USE_HTTPS}`;

export const httpRefused = (registry: string) =>
  `${plainRegistry(registry)}, then run this again. Nothing was added; to add the server anyway, pass ${ALLOW_HTTP_REGISTRY}`;

export const NPM_MISSING = "npm was not found, so its registry was not checked; the server starts with npx, which comes with npm";

export const npmFailed = (reason: string) => `npm config get registry failed (${reason}), so its registry was not checked`;

const clipped = (text: string) => (text.length > REASON_LIMIT ? `${text.slice(0, REASON_LIMIT)}...` : text);

export async function npmRegistry(launch: Launch): Promise<Registry> {
  let ran: Launched | null;
  try {
    ran = await launch(NPM, REGISTRY_ARGS, REGISTRY_TIMEOUT_MS);
  } catch (error) {
    return { read: "failed", reason: clipped(error instanceof Error ? error.message : String(error)) };
  }
  if (ran === null) {
    return { read: "missing" };
  }
  if (ran.code !== 0) {
    return { read: "failed", reason: clipped(`exit ${ran.code}: ${ran.output.trim() === "" ? "it printed nothing" : ran.output.trim()}`) };
  }
  const registry = ran.output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\/\S+$/i.test(line))
    .at(-1);
  if (registry === undefined) {
    return { read: "failed", reason: "it printed no registry url" };
  }
  return { read: /^https:/i.test(registry) ? "https" : "http", registry };
}

export function registryWarning(registry: Registry): string | undefined {
  switch (registry.read) {
    case "https":
      return undefined;
    case "http":
      return plainRegistry(registry.registry);
    case "missing":
      return NPM_MISSING;
    case "failed":
      return npmFailed(registry.reason);
  }
}
