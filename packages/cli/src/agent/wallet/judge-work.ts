import type { Address } from "@solana/kit";
import { type AgentContext, define } from "../actions.js";
import { tool } from "../names.js";
import { AgentRefusal } from "../problems.js";
import { account, amount, choice, flag, integer, list, object, optional, text } from "../schema.js";
import { getSpec } from "../spec.js";
import { walletFetchWork } from "./work.js";
import { JudgeRefused } from "../../judge-errors.js";
import { HOST_ENGINE, judgeHost } from "../../host-judge.js";
import { type Cases, casesOf, type Failure, judgeViper, MAX_CASES, pinnedWasm, REPORTED_FAILURES, runOf, VIPER_ENGINE_COMMIT, VIPER_WASM_SHA256 } from "../../viper.js";
import { sanitized } from "../../untrusted-text.js";

export const JUDGE_SECONDS = 60;

export const DETAIL_LIMIT = 256;

export const VERDICTS = ["pass", "wrong", "not-primitive", "threw", "stopped", "no-module", "engine", "crashed"] as const;

export const NO_CASES = `this spec has no judge-cases block this tool can run; save the spec and the work and judge them with the CLI command judge --sandbox docker`;

export const DRAWS_CASES = "this spec draws its cases from a finalized block, which this tool does not wait for; judge it with the CLI command judge --sandbox viper";

export const JUDGED_PASS = `every case passed in both engines and nothing was sent; preview ${tool("wallet_attest")} with sha256 as delivered_sha256, or ${tool("wallet_committee_vote")} for a committee, and send it only after the user says yes`;

export const JUDGED_FAIL = "the work failed the spec's cases, as cases and host list; approve nothing and tell the user which cases failed";

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

type Fetched = { intent: Address; announcement: Address; worker: Address; sha256: string; opens_commitment: boolean; untrusted_text?: string; first?: { worker: Address }; next: string };

export const walletJudgeWork = define({
  name: tool("wallet_judge_work"),
  title: "Judge announced work in the ViperJS sandbox",
  description: `Judges announced work against the escrow's spec and its judge-cases block, running every case in the pinned ViperJS sandbox and a second engine; returns the verdict, failed cases and the work's sha256. Needs neither Docker nor WSL and sends nothing. A spec without judge cases is refused: use the CLI command judge --sandbox docker. On a pass, pay with ${tool("wallet_attest")}.`,
  effect: "read",
  input: object({
    intent: account("the proof escrow's intent address"),
    announcement: optional(account(`the announcement whose work to judge, as ${tool("wallet_check_delivery")} lists it; default the earliest one this wallet opens`)),
  }),
  output: object({
    intent: account(),
    announcement: account("the announcement whose work was judged"),
    worker: account("the wallet a release for this work pays"),
    sha256: text("64 hex: the sha256 of the judged work; pass it as delivered_sha256"),
    opens_commitment: flag("true only when sha256 opens the announcement's commitment"),
    verdict: choice(["pass", "fail"] as const, "pass only when every case passed in both engines"),
    engine: object({ wasm_sha256: text(), commit: text() }, "the pinned ViperJS judge that ran"),
    seed: amount("the random seed both engines ran with"),
    cases: judgedSchema("the ViperJS sandbox"),
    host: judgedSchema(HOST_ENGINE),
    sent: flag("always false: this tool sends nothing"),
    next: text(),
  }),
  run: async (ctx: AgentContext, input) => {
    const cases = await judgeCases(ctx, input.intent);
    const work = (await readWith(walletFetchWork)(ctx, input)) as Fetched;
    if (work.untrusted_text === undefined) {
      throw new AgentRefusal("NotJudged", "the work is not UTF-8 text, so it is not a module the ViperJS judge can run; nothing was run");
    }
    const module = new TextEncoder().encode(work.untrusted_text);
    const wasm = await pinnedWasm().catch(notJudged);
    const run = runOf(cases);
    const deadline = Date.now() + JUDGE_SECONDS * 1000;
    const left = () => Math.max(0, deadline - Date.now()) / 1000;
    const viper = await judgeViper(wasm, module, cases, left(), run).catch(notJudged);
    const host = await judgeHost(module, cases, left(), run.seed).catch(notJudged);
    const agreed = (judged: { total: number; passed: number }) => judged.total > 0 && judged.passed === judged.total;
    const passed = agreed(viper) && agreed(host);
    const settles = work.opens_commitment && work.first !== undefined;
    return {
      intent: work.intent,
      announcement: work.announcement,
      worker: work.first?.worker ?? work.worker,
      sha256: work.sha256,
      opens_commitment: work.opens_commitment,
      verdict: passed ? "pass" : "fail",
      engine: { wasm_sha256: VIPER_WASM_SHA256, commit: VIPER_ENGINE_COMMIT },
      seed: BigInt(run.seed),
      cases: { total: viper.total, passed: viper.passed, failures: failuresOf(viper.failures) },
      host: { total: host.total, passed: host.passed, failures: failuresOf(host.failures) },
      sent: false,
      next: !passed ? JUDGED_FAIL : settles ? JUDGED_PASS : work.next,
    };
  },
});
