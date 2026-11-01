import { CLI_PACKAGE } from "./add-to.js";
import type { Env } from "./args.js";
import { NPM_REGISTRY } from "./npm-registry.js";
import { VERSION } from "./version.js";
import { type Files, settingsDir } from "./wallet.js";

export const NO_UPDATE_CHECK = "INTENT_ENGINE_NO_UPDATE_CHECK";
export const UPDATE_COMMAND = `npx -y ${CLI_PACKAGE}@latest version`;
export const UPDATE_AFTER = "restart the app";
export const UPDATE_TIMEOUT_MS = 3_000;
export const UPDATE_CACHE_SECONDS = 86_400n;
export const UPDATE_URL = `${NPM_REGISTRY}${CLI_PACKAGE.replace("/", "%2f")}/latest`;
export const updateCachePath = (home: string) => `${settingsDir(home)}/update-check.json`;

export type UpdateFetch = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export type UpdateCheck = {
  files: Pick<Files, "home" | "readText" | "saveText">;
  env: Env;
  fetch: UpdateFetch;
  now(): bigint;
  timeoutMs?: number;
  current?: string;
};

const SEMVER = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/;

const parts = (version: string): number[] | undefined => SEMVER.exec(version)?.slice(1).map(Number);

const newer = (latest: string, current: string): boolean => {
  const a = parts(latest);
  const b = parts(current);
  if (a === undefined || b === undefined) {
    return false;
  }
  const at = a.findIndex((n, i) => n !== b[i]);
  return at !== -1 && (a[at] ?? 0) > (b[at] ?? 0);
};

const versionOf = (body: unknown): string | undefined => {
  const version = body !== null && typeof body === "object" ? (body as { version?: unknown }).version : undefined;
  return typeof version === "string" && parts(version) !== undefined ? version : undefined;
};

async function cached(check: UpdateCheck): Promise<string | undefined> {
  try {
    const saved: unknown = JSON.parse(await check.files.readText(updateCachePath(check.files.home)));
    const { checked, latest } = saved as { checked?: unknown; latest?: unknown };
    const at = typeof checked === "string" && /^\d{1,15}$/.test(checked) ? BigInt(checked) : undefined;
    const age = at === undefined ? undefined : check.now() - at;
    return age !== undefined && age >= 0n && age < UPDATE_CACHE_SECONDS ? versionOf({ version: latest }) : undefined;
  } catch {
    return undefined;
  }
}

async function asked(check: UpdateCheck): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const silent = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), check.timeoutMs ?? UPDATE_TIMEOUT_MS);
  });
  const answer = (async () => {
    try {
      const reply = await check.fetch(UPDATE_URL);
      return reply.ok ? versionOf(await reply.json()) : undefined;
    } catch {
      return undefined;
    }
  })();
  try {
    return await Promise.race([answer, silent]);
  } finally {
    clearTimeout(timer);
  }
}

export async function newerVersion(check: UpdateCheck): Promise<string | undefined> {
  try {
    if (check.env[NO_UPDATE_CHECK] !== undefined && check.env[NO_UPDATE_CHECK] !== "") {
      return undefined;
    }
    let latest = await cached(check);
    if (latest === undefined) {
      latest = await asked(check);
      if (latest !== undefined) {
        await check.files.saveText(updateCachePath(check.files.home), `${JSON.stringify({ checked: check.now().toString(), latest })}\n`, false).catch(() => undefined);
      }
    }
    return latest !== undefined && newer(latest, check.current ?? VERSION) ? latest : undefined;
  } catch {
    return undefined;
  }
}

export const updateField = (version: string) => ({ version, command: UPDATE_COMMAND, after: UPDATE_AFTER });

export const updateOf = async (latest: Promise<string | undefined> | undefined): Promise<{ update: ReturnType<typeof updateField> } | Record<string, never>> => {
  const version = await latest;
  return version === undefined ? {} : { update: updateField(version) };
};
