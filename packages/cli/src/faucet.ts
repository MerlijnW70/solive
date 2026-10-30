import type { Address } from "@solana/kit";
import { PRODUCT_REPOSITORY } from "@intent-engine/core/internal";
import type { Launched } from "./launch.js";
import { escaped } from "./untrusted-text.js";
import type { Env } from "./command-types.js";

export const GH = "gh";
export const FAUCET_TITLE = "Devnet SOL";
export const FAUCET_MINUTE = 7;
export const FAUCET_INTERVAL_MINUTES = 15;
export const FAUCET_RUN_MINUTES = 10;
export const FAUCET_WAIT_MINUTES = FAUCET_INTERVAL_MINUTES + FAUCET_RUN_MINUTES;
export const FAUCET_POLL_SECONDS = 30;

export const FAUCET_SCHEDULE = `the faucet answers new requests at least every ${FAUCET_INTERVAL_MINUTES} minutes, so SOL arrives within ${FAUCET_WAIT_MINUTES} minutes`;
export const GH_HINT = "intent-engine setup --faucet files a faucet request with a signed-in GitHub CLI (gh) and waits for the SOL; or ";
export const GH_GONE = "the GitHub CLI (gh) was not found";
export const GH_MISSING = `${GH_GONE}, so `;
export const GH_SIGNED_OUT = "the GitHub CLI is not signed in (run gh auth login), so ";

export const faucetWaiting = (url: string) =>
  `filed ${url}; waiting up to ${FAUCET_WAIT_MINUTES} minutes for SOL, checking every ${FAUCET_POLL_SECONDS} seconds`;
export const faucetPending = (url: string) =>
  `no SOL arrived within ${FAUCET_WAIT_MINUTES} minutes; the faucet answers on ${url}: read it, and run setup again once SOL arrives`;
export const ghFailed = (code: number, output: string) => `the GitHub CLI could not file the faucet request (exit ${code}): ${output.trim()}`;

export type Launch = (program: string, args: readonly string[]) => Promise<Launched | null>;

export type Filed = { url: string } | { hint: string };

const repository = () => {
  const [owner = "", name = ""] = new URL(PRODUCT_REPOSITORY).pathname.split("/").filter((part) => part !== "");
  return { owner, name };
};

async function gh(launch: Launch, args: readonly string[]): Promise<string> {
  const ran = await launch(GH, args);
  if (ran === null) {
    throw new Error(GH_GONE);
  }
  if (ran.code !== 0) {
    throw new Error(ghFailed(ran.code, ran.output));
  }
  return ran.output.trim();
}

export async function fileFaucetRequest(launch: Launch, address: Address): Promise<Filed> {
  const signedIn = await launch(GH, ["auth", "status", "--hostname", "github.com"]);
  if (signedIn === null) {
    return { hint: GH_MISSING };
  }
  if (signedIn.code !== 0) {
    return { hint: GH_SIGNED_OUT };
  }
  const { owner, name } = repository();
  const filed = await gh(launch, ["issue", "create", "--repo", `${owner}/${name}`, "--title", FAUCET_TITLE, "--body", address]);
  return { url: filed.split("\n").pop()?.trim() ?? filed };
}

export const FAUCET_TIMEOUT_MS = 45000;
export const FAUCET_URL_ENV = "INTENT_ENGINE_FAUCET_URL";
export const FAUCET_DEFAULT_URL = "https://solive-faucet.vercel.app";
export const FAUCET_OFF = "off";
export const FAUCET_DRIP_PATH = "/api/drip";
export const REFUSAL_LIMIT = 200;

export const FAUCET_PLAIN_URL = "the instant faucet url must start with https://";
export const FAUCET_UNREADABLE_URL = "the instant faucet url is not a valid url";
export const FAUCET_UNREACHABLE = "the instant faucet could not be reached";
export const FAUCET_TIMED_OUT = "the instant faucet did not answer in time";
export const FAUCET_SILENT = "the instant faucet gave no reason";
export const FAUCET_MALFORMED = "the instant faucet sent a reply this CLI does not recognise";

export type FaucetFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; redirect: "error"; signal: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export type InstantFaucet = { lamports: string; signature: string } | { refused: string };

const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const LAMPORTS = /^[0-9]{1,19}$/;
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const refusalText = (text: string): string => Array.from(escaped(text)).slice(0, REFUSAL_LIMIT).join("");

function dripUrl(env: Env): string | InstantFaucet | null {
  const given = env[FAUCET_URL_ENV];
  const base = given === undefined || given === "" ? FAUCET_DEFAULT_URL : given;
  if (base === FAUCET_OFF) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return { refused: FAUCET_UNREADABLE_URL };
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && LOCAL_HOSTS.has(parsed.hostname))) {
    return { refused: FAUCET_PLAIN_URL };
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}${FAUCET_DRIP_PATH}`;
}

function refusalOf(status: number, body: unknown): InstantFaucet {
  const said = body !== null && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "";
  return { refused: refusalText(said === "" ? `${FAUCET_SILENT} (status ${status})` : said) };
}

function dripOf(body: unknown): InstantFaucet {
  const fields = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const { lamports, signature } = fields;
  return typeof lamports === "string" && LAMPORTS.test(lamports) && typeof signature === "string" && SIGNATURE.test(signature)
    ? { lamports, signature }
    : { refused: FAUCET_MALFORMED };
}

export async function askInstantFaucet(fetcher: FaucetFetch | undefined, env: Env, address: string): Promise<InstantFaucet | null> {
  if (fetcher === undefined) {
    return null;
  }
  const target = dripUrl(env);
  if (target === null || typeof target === "object") {
    return target;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FAUCET_TIMEOUT_MS);
  const timedOut = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error(FAUCET_TIMED_OUT)), { once: true }));
  timedOut.catch(() => undefined);
  try {
    const reply = await Promise.race([
      fetcher(target, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }), redirect: "error", signal: controller.signal }),
      timedOut,
    ]);
    const body = await Promise.race([reply.json().catch(() => null), timedOut]);
    return reply.status === 200 ? dripOf(body) : refusalOf(reply.status, body);
  } catch (error) {
    return { refused: error instanceof Error && error.message === FAUCET_TIMED_OUT ? FAUCET_TIMED_OUT : FAUCET_UNREACHABLE };
  } finally {
    clearTimeout(timer);
  }
}
