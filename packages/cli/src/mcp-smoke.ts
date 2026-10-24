import { formatAmount, parseAmount } from "@intent-engine/core";
import { tool } from "./agent/names.js";
import { clusterUrl } from "./clusters.js";

export type ToolResult = { isError?: boolean | undefined; structuredContent?: unknown };
export type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
export type SmokeParties = { hirer: ToolCaller; worker: ToolCaller };
export type SmokeRun = { specUrl: string; specText: string; workUrl: string; work: string; wait: number };
export type SmokeOptions = { url: string; hirerKey: string; workerKey: string; specUrl: string };
export type SmokeResult = { intent: string; release: string; steps: string[] };

type Fields = Record<string, unknown>;

export const SMOKE_SOL = "0.01";
export const SMOKE_RESERVE = "0.01";
export const SMOKE_WAIT = 40;
export const SMOKE_USAGE = "usage: bash scripts/mcp-smoke.sh <url> <hirer key> <worker key> <spec url>";
export const SMOKE_NOT_MAINNET = "mcp-smoke runs on devnet, testnet or localnet only, never mainnet";
export const SMOKE_SAME_KEY = "mcp-smoke needs two different keys: one for the hirer and one for the worker";
export const SMOKE_SPEC_HTTPS = "the spec url must be an https url";

const SOL_DECIMALS = 9;

export class SmokeUsage extends Error {}

export class SmokeFailed extends Error {
  constructor(
    readonly step: string,
    readonly problem: string,
  ) {
    super(`${step} failed: ${problem}`);
  }
}

export function smokeOptions(argv: readonly string[]): SmokeOptions {
  const [url, hirerKey, workerKey, specUrl, ...rest] = argv;
  if (url === undefined || hirerKey === undefined || workerKey === undefined || specUrl === undefined || rest.length > 0) {
    throw new SmokeUsage(SMOKE_USAGE);
  }
  if (/mainnet/i.test(clusterUrl(url))) {
    throw new SmokeUsage(SMOKE_NOT_MAINNET);
  }
  if (hirerKey === workerKey) {
    throw new SmokeUsage(SMOKE_SAME_KEY);
  }
  if (!specUrl.startsWith("https://")) {
    throw new SmokeUsage(SMOKE_SPEC_HTTPS);
  }
  return { url: clusterUrl(url), hirerKey, workerKey, specUrl };
}

export const serverArgs = (url: string): string[] => ["mcp", "--url", url, "--wallet", "--wallet-per-trade", `SOL=${SMOKE_SOL}`];

export const smokeWork = (specUrl: string, at: bigint): string => `mcp smoke work for ${specUrl} at ${at}\n`;

export const missing = (field: string): string => `the reply has no ${field}`;
export const notSent = "the reply does not say it was sent";
export const previewSent = "the preview says it was sent";
export const jobMissing = (intent: string): string => `no listed job is the escrow ${intent}`;
export const specMismatch = (sha256: string, specHash: string): string => `the spec hashes to ${sha256}, not the escrow's spec_hash ${specHash}`;
export const deliveryMissing = (sha256: string, worker: string): string => `no delivery of ${sha256} by ${worker}`;
export const notReleased = "the escrow is not released";
export const releaseMismatch = (sha256: string): string => `the release does not record the delivered sha256 ${sha256}`;
export const releaseOther = (receipt: string, attest: string): string => `the receipt names the release ${receipt}, not ${attest}`;
export const tooPoor = (sol: string, needed: string): string => `the hirer holds ${sol} SOL and needs at least ${needed}`;

function problemOf(value: unknown): string {
  const fields = (typeof value === "object" && value !== null ? value : {}) as Fields;
  const head = `${String(fields["code"] ?? "Error")}: ${String(fields["hint"] ?? "")}`;
  const issues = Array.isArray(fields["issues"])
    ? (fields["issues"] as Fields[]).map((issue) => `${String(issue["path"])} ${String(issue["message"])}`)
    : [];
  return issues.length === 0 ? head : `${head} (${issues.join("; ")})`;
}

function text(fields: Fields, field: string, step: string): string {
  const value = fields[field];
  if (typeof value !== "string" || value === "") {
    throw new SmokeFailed(step, missing(field));
  }
  return value;
}

export async function smoke(parties: SmokeParties, run: SmokeRun, report: (line: string) => void = () => undefined): Promise<SmokeResult> {
  const steps: string[] = [];
  const done = (step: string, detail: string) => {
    steps.push(step);
    report(`ok ${step}: ${detail}`);
  };
  const call = async (step: string, caller: ToolCaller, name: string, args: Fields): Promise<Fields> => {
    let result: ToolResult;
    try {
      result = await caller(tool(name), args);
    } catch (error) {
      throw new SmokeFailed(step, error instanceof Error ? error.message : String(error));
    }
    if (result.isError === true) {
      throw new SmokeFailed(step, problemOf(result.structuredContent));
    }
    const value = result.structuredContent;
    if (typeof value !== "object" || value === null) {
      throw new SmokeFailed(step, missing("structured content"));
    }
    return value as Fields;
  };
  const send = async (step: string, caller: ToolCaller, name: string, args: Fields): Promise<Fields> => {
    const preview = await call(`${step} preview`, caller, name, args);
    if (preview["sent"] !== false) {
      throw new SmokeFailed(`${step} preview`, previewSent);
    }
    done(`${step} preview`, Array.isArray(preview["summary"]) ? String(preview["summary"][0]) : "shown");
    const approval = typeof preview["approval"] === "string" ? { approval: preview["approval"] } : {};
    const sent = await call(step, caller, name, { ...args, ...approval, send: true });
    if (sent["sent"] !== true) {
      throw new SmokeFailed(step, notSent);
    }
    return { ...preview, ...sent, signature: text(sent, "signature", step) };
  };

  const hirerWallet = await call("hirer wallet", parties.hirer, "wallet_balance", { mints: ["SOL"] });
  const hirer = text(hirerWallet, "address", "hirer wallet");
  const held = text(hirerWallet, "sol", "hirer wallet");
  const needed = parseAmount(SMOKE_SOL, SOL_DECIMALS) + parseAmount(SMOKE_RESERVE, SOL_DECIMALS);
  if (parseAmount(held, SOL_DECIMALS) < needed) {
    throw new SmokeFailed("hirer wallet", tooPoor(held, formatAmount(needed, SOL_DECIMALS)));
  }
  done("hirer wallet", `${hirer} holds ${held} SOL`);
  const worker = text(await call("worker wallet", parties.worker, "wallet_balance", { mints: ["SOL"] }), "address", "worker wallet");
  done("worker wallet", worker);

  const specHash = text(await call("spec hash", parties.hirer, "hash", { text: run.specText }), "sha256", "spec hash");
  done("spec hash", specHash);

  const escrow = await send("escrow", parties.hirer, "wallet_escrow", {
    sell: "SOL",
    amount: SMOKE_SOL,
    attestor: hirer,
    min_result: "1",
    max_result: "1",
    spec_hash: specHash,
    spec_url: run.specUrl,
  });
  const intent = text(escrow, "intent", "escrow");
  const nonce = text(escrow, "nonce", "escrow");
  done("escrow", `${intent} nonce ${nonce} in ${String(escrow["signature"])}`);

  const listed = await call("find job", parties.worker, "find_jobs", { attestor: hirer, wait: run.wait });
  const jobs = Array.isArray(listed["jobs"]) ? (listed["jobs"] as Fields[]) : [];
  const job = jobs.find((j) => j["intent"] === intent);
  if (job === undefined) {
    throw new SmokeFailed("find job", jobMissing(intent));
  }
  if (job["spec_url"] !== run.specUrl) {
    throw new SmokeFailed("find job", missing(`spec_url ${run.specUrl}`));
  }
  if (job["spec_hash"] !== specHash) {
    throw new SmokeFailed("find job", missing(`spec_hash ${specHash}`));
  }
  done("find job", `${intent} pays ${String(job["net_pay"])}`);

  const spec = await call("get spec", parties.worker, "get_spec", { intent });
  const fetched = text(spec, "sha256", "get spec");
  if (spec["matches"] !== true || fetched !== specHash) {
    throw new SmokeFailed("get spec", specMismatch(fetched, specHash));
  }
  done("get spec", `matches ${specHash}`);

  const work = text(await call("hash work", parties.worker, "hash", { text: run.work }), "sha256", "hash work");
  done("hash work", work);

  const delivered = await send("deliver", parties.worker, "wallet_deliver", { intent, sha256: work, url: run.workUrl });
  done("deliver", `announced in ${String(delivered["signature"])}`);

  const checked = await call("check delivery", parties.worker, "wallet_check_delivery", { intent });
  const mine = Array.isArray(checked["mine"]) ? (checked["mine"] as Fields[]) : [];
  if (!mine.some((one) => one["announcement"] === delivered["announcement"] && one["earlier"] === 0)) {
    throw new SmokeFailed("check delivery", deliveryMissing(work, worker));
  }
  done("check delivery", `${work} by ${worker}`);

  const attested = await send("attest", parties.hirer, "wallet_attest", { owner: hirer, nonce, delivered_sha256: work });
  const release = String(attested["signature"]);
  done("attest", `paid ${String(attested["paid"])} in ${release}`);

  const receipt = await call("receipt", parties.worker, "wallet_receipt", { owner: hirer, nonce, sha256: work, wait: run.wait });
  if (receipt["released"] !== true) {
    throw new SmokeFailed("receipt", notReleased);
  }
  if (receipt["matches"] !== true) {
    throw new SmokeFailed("receipt", releaseMismatch(work));
  }
  const seen = text(receipt, "signature", "receipt");
  if (seen !== release) {
    throw new SmokeFailed("receipt", releaseOther(seen, release));
  }
  done("receipt", `released in ${release}`);

  const unwrapped = await send("unwrap", parties.worker, "wallet_unwrap", {});
  done("unwrap", `${String(unwrapped["wrapped"])} SOL in ${String(unwrapped["signature"])}`);

  return { intent, release, steps };
}
