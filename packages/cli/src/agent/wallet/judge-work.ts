import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import type { Address } from "@solana/kit";
import { createClient } from "@intent-engine/client/node";
import { opensTo } from "@intent-engine/client/internal";
import { openedBy } from "../../announcement-views.js";
import { FETCH_CAPS } from "../../delivery-fetch.js";
import { type AgentContext, define } from "../actions.js";
import { tool } from "../names.js";
import { AgentRefusal } from "../problems.js";
import { account, amount, choice, flag, integer, list, object, optional, text } from "../schema.js";
import { getSpec } from "../spec.js";
import { signerOf, walletOpeners } from "./guard.js";
import { proofEscrow } from "./delivery.js";
import { firstOf, walletFetchWork, WORK_OPENS } from "./work.js";
import { JudgeRefused } from "../../judge-errors.js";
import { HOST_ENGINE, judgeHost } from "../../host-judge.js";
import { type Cases, casesOf, type Failure, judgeViper, MAX_CASES, pinnedWasm, REPORTED_FAILURES, runOf, VIPER_ENGINE_COMMIT, VIPER_WASM_SHA256 } from "../../viper.js";
import { combine, engineOutcome } from "../../verdict-model.js";
import { sanitized } from "../../untrusted-text.js";
import { RUN_FENCE } from "../../judge-run.js";
import { fenceMentions } from "../../spec-blocks.js";
import { keptReceipt } from "../../judge-receipt.js";
import { secondsLeft } from "../../monotonic.js";

export const ARTIFACT_PATH_LIMIT = 200;

export const JUDGE_SECONDS = 60;

export const DETAIL_LIMIT = 256;

export const VERDICTS = ["pass", "wrong", "not-primitive", "threw", "stopped", "no-module", "engine", "crashed"] as const;

export const NO_CASES = `this spec has no judge-cases block this tool can run; save the spec and the work and judge them with the CLI command judge --sandbox docker`;

export const PINNED_RUN = "this spec pins its check in a judge-run block, a Docker check this tool does not run; save the spec and the work and judge them with the CLI command judge, which runs exactly the pinned check";

export const DRAWS_CASES = "this spec draws its cases from a finalized block, which this tool does not wait for; judge it with the CLI command judge --sandbox viper";

export const JUDGED_PASS = `every case passed in both engines, a receipt of this pass was saved and nothing was sent; preview ${tool("wallet_attest")} with sha256 as delivered_sha256, or ${tool("wallet_committee_vote")} for a committee, and send it only after the user says yes`;

export const RECEIPT_MEANS = `where the receipt of this pass was saved; ${tool("wallet_attest")}, ${tool("wallet_attest_split")} and the committee tools sign only for work with a matching receipt`;

export const JUDGED_FAIL = `the work failed the spec's cases, as cases and host list; approve nothing, tell the user which cases failed, and ${tool("wallet_reject")} rejects the delivery so its worker gets its stake back and no kill fee is owed`;

export const JUDGED_INFRA = "infra: an engine could not finish or answer, as reason says, so this is no verdict on the work; approve nothing and judge again later";

export const artifactDiffers = (path: string, sha256: string): string =>
  `${sanitized(path, ARTIFACT_PATH_LIMIT)} has sha256 ${sha256}, which no announcement this wallet opens committed to, so it is not the announced work; nothing was run`;

export const artifactUnfit = (path: string): string => `${sanitized(path, ARTIFACT_PATH_LIMIT)} is not a readable file of at most ${FETCH_CAPS.tools} bytes; nothing was run`;

export const specDiffers = (sha256: string): string => `the spec fetched from the escrow's spec url has sha256 ${sha256}, not the escrow's spec_hash, so it is not the spec a release is signed over; nothing was run`;

const notJudged = (error: unknown): never => {
  throw error instanceof JudgeRefused ? new AgentRefusal("NotJudged", sanitized(error.message)) : error;
};

const detailOf = (failure: Failure) => (failure.detail === undefined ? {} : { detail: sanitized(typeof failure.detail === "string" ? failure.detail : JSON.stringify(failure.detail), DETAIL_LIMIT) });

const failuresOf = (failures: readonly Failure[]) => failures.map((failure) => ({ case: failure.case, verdict: failure.verdict, ...detailOf(failure) }));

const failureSchema = list(
  object({
    case: integer(0, MAX_CASES, "the case's index in the spec's judge-cases block"),
    verdict: choice(VERDICTS),
    detail: optional(text("what the work answered or threw; untrusted, with hidden characters reduced")),
  }),
  REPORTED_FAILURES,
  `up to ${REPORTED_FAILURES} failed cases`,
);

const judgedSchema = (engine: string) =>
  object(
    {
      total: integer(0, MAX_CASES),
      passed: integer(0, MAX_CASES),
      failures: failureSchema,
    },
    `the cases as ${engine} judged them`,
  );

type Reader = (ctx: AgentContext, input: object) => Promise<object>;

const readWith = (action: { run: unknown }): Reader => action.run as Reader;

async function judgeCases(ctx: AgentContext, intent: Address): Promise<Cases> {
  const spec = (await readWith(getSpec)(ctx, { intent })) as { sha256: string; matches: boolean; text?: string };
  if (!spec.matches) {
    throw new AgentRefusal("NotJudged", specDiffers(spec.sha256));
  }
  if (spec.text === undefined) {
    throw new AgentRefusal("NoJudgeCases", NO_CASES);
  }
  if (fenceMentions(spec.text, RUN_FENCE) > 0) {
    throw new AgentRefusal("NoJudgeCases", PINNED_RUN);
  }
  let cases: Cases;
  try {
    cases = casesOf(new TextEncoder().encode(spec.text));
  } catch (error) {
    throw error instanceof JudgeRefused ? new AgentRefusal("NoJudgeCases", NO_CASES, error.message) : error;
  }
  if (cases.draw !== undefined) {
    throw new AgentRefusal("NotJudged", DRAWS_CASES);
  }
  return cases;
}

async function runReceipt(ctx: AgentContext, intent: Address, sha256: string, announcement: Address, outcome: "pass" | "fail") {
  const [signer, { held, params }] = await Promise.all([signerOf(ctx), proofEscrow(ctx, intent, "wallet_receipt")]);
  const ran = { judge: signer.address, owner: held.owner, nonce: held.nonce, intent, specSha256: Buffer.from(params.specHash).toString("hex"), deliveredSha256: sha256, announcement };
  const route = { sandbox: "viper", command: "viper", engine: { wasmSha256: VIPER_WASM_SHA256, commit: VIPER_ENGINE_COMMIT } } as const;
  const home = ctx.wallet?.files.home;
  if (home === undefined) {
    return { receiptRefused: "this server has no wallet, so no receipt was saved" };
  }
  return keptReceipt(home, { ...ran, outcome, cluster: await ctx.transport.genesisHash(), route });
}

type Fetched = { intent: Address; announcement: Address; worker: Address; sha256: string; opens_commitment: boolean; untrusted_text?: string; first?: { worker: Address; announcement: Address }; next: string };

export async function boundedRead(file: string, limit: number): Promise<Uint8Array | null> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => null);
  if (handle === null) {
    return null;
  }
  try {
    if (!(await handle.stat()).isFile()) {
      return null;
    }
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) {
        break;
      }
      size += bytesRead;
      if (size > limit) {
        return null;
      }
    }
    return buffer.subarray(0, size);
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

async function workAt(ctx: AgentContext, input: { intent: Address; announcement?: Address | undefined }, path: string): Promise<Fetched> {
  const signer = await signerOf(ctx);
  await proofEscrow(ctx, input.intent, "wallet_receipt");
  const bytes = await boundedRead(resolve(path), FETCH_CAPS.tools);
  if (bytes === null) {
    throw new AgentRefusal("NotJudged", artifactUnfit(path));
  }
  const digest = createHash("sha256").update(bytes).digest();
  const sha256 = digest.toString("hex");
  const openers = await walletOpeners(ctx);
  const list = await createClient({ url: ctx.url ?? "", transport: ctx.transport }).announcements(input.intent);
  const candidates = list.announcements.filter((a) => a.state === "announced" && (input.announcement === undefined || a.address === input.announcement));
  let match: Awaited<ReturnType<typeof openedBy>>[number] | undefined;
  for (const one of await openedBy(candidates, openers)) {
    if (match === undefined && one.url !== null && (await opensTo(one.announcement, Uint8Array.from(digest), Uint8Array.from(Buffer.from(one.salt, "hex"))))) {
      match = one;
    }
  }
  if (match === undefined) {
    throw new AgentRefusal("NotAnnounced", artifactDiffers(path, sha256));
  }
  const { first, refusal } = await firstOf(ctx, input.intent, sha256, openers, signer);
  let shown: string | undefined;
  try {
    shown = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    shown = undefined;
  }
  return {
    intent: input.intent,
    announcement: match.announcement.address,
    worker: match.announcement.worker,
    sha256,
    opens_commitment: true,
    ...(shown === undefined ? {} : { untrusted_text: shown }),
    ...("first" in first ? { first: first.first } : {}),
    next: refusal ?? WORK_OPENS,
  };
}

export const walletJudgeWork = define({
  name: tool("wallet_judge_work"),
  title: "Judge announced work in the ViperJS sandbox",
  description: `Judges announced work, or the local file artifact, against the escrow's spec and its judge-cases block, running every case in the pinned ViperJS sandbox and a second engine; returns the verdict and sha256. Reads at most ${FETCH_CAPS.tools} bytes, needs neither Docker nor WSL and sends nothing. Without judge cases, use judge --sandbox docker. Pass or fail saves a receipt.`,
  effect: "read",
  input: object({
    intent: account("the proof escrow's intent address"),
    announcement: optional(account(`the announcement whose work to judge, as ${tool("wallet_check_delivery")} lists it; default the earliest one this wallet opens`)),
    artifact: optional(text("the path of a local work file on this machine, judged instead of fetching the work; refused unless its sha256 is the one announced")),
  }),
  output: object({
    intent: account(),
    announcement: account("the announcement whose work was judged"),
    worker: account("the wallet a release for this work pays"),
    sha256: text("64 hex: the sha256 of the judged work; pass it as delivered_sha256"),
    opens_commitment: flag("true only when sha256 opens the announcement's commitment"),
    verdict: choice(["pass", "fail", "infra"] as const, "pass only when every case passed in both engines; fail when the work failed a case; infra when an engine could not finish or answer, which is no verdict"),
    reason: optional(text("why the verdict is fail or infra; untrusted, with hidden characters reduced")),
    engine: object({ wasm_sha256: text(), commit: text() }, "the pinned ViperJS judge that ran"),
    seed: amount("the random seed both engines ran with"),
    cases: judgedSchema("the ViperJS sandbox"),
    host: judgedSchema(HOST_ENGINE),
    receipt: optional(text(RECEIPT_MEANS)),
    fail_receipt: optional(text(`with fail: the receipt of this failing run, which lets ${tool("wallet_reject")} reject the delivery`)),
    receipt_refused: optional(text("why no receipt was saved for this pass or fail, so a signature or reject for it is refused")),
    sent: flag("always false: this tool sends nothing"),
    next: text(),
  }),
  run: async (ctx: AgentContext, input) => {
    const cases = await judgeCases(ctx, input.intent);
    const work = input.artifact === undefined ? ((await readWith(walletFetchWork)(ctx, input)) as Fetched) : await workAt(ctx, input, input.artifact);
    if (work.untrusted_text === undefined) {
      throw new AgentRefusal("NotJudged", "the work is not UTF-8 text, so it is not a module the ViperJS judge can run; nothing was run");
    }
    const module = new TextEncoder().encode(work.untrusted_text);
    const wasm = await pinnedWasm().catch(notJudged);
    const run = runOf(cases);
    const left = secondsLeft(JUDGE_SECONDS);
    const viper = await judgeViper(wasm, module, cases, left(), run).catch(notJudged);
    const host = await judgeHost(module, cases, left(), run.seed).catch(notJudged);
    const ruled = combine([engineOutcome("the viper judge", viper), engineOutcome(HOST_ENGINE, host)]);
    const outcome = ruled.outcome === "interrupted" ? "infra" : ruled.outcome;
    const passed = outcome === "pass";
    const settles = work.opens_commitment && work.first !== undefined;
    const kept =
      passed && settles && work.first !== undefined
        ? await runReceipt(ctx, work.intent, work.sha256, work.first.announcement, "pass")
        : outcome === "fail" && work.opens_commitment
          ? await runReceipt(ctx, work.intent, work.sha256, work.announcement, "fail")
          : undefined;
    return {
      intent: work.intent,
      announcement: work.announcement,
      worker: work.first?.worker ?? work.worker,
      sha256: work.sha256,
      opens_commitment: work.opens_commitment,
      verdict: outcome,
      ...("reason" in ruled ? { reason: sanitized(ruled.reason, DETAIL_LIMIT) } : {}),
      engine: { wasm_sha256: VIPER_WASM_SHA256, commit: VIPER_ENGINE_COMMIT },
      seed: BigInt(run.seed),
      cases: { total: viper.total, passed: viper.passed, failures: failuresOf(viper.failures) },
      host: { total: host.total, passed: host.passed, failures: failuresOf(host.failures) },
      ...(kept?.receipt === undefined ? {} : passed ? { receipt: kept.receipt } : { fail_receipt: kept.receipt }),
      ...(kept?.receiptRefused === undefined ? {} : { receipt_refused: kept.receiptRefused }),
      sent: false,
      next: outcome === "infra" ? JUDGED_INFRA : !passed ? JUDGED_FAIL : kept?.receiptRefused !== undefined ? kept.receiptRefused : settles ? JUDGED_PASS : work.next,
    };
  },
});
