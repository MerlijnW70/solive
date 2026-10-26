import { tool } from "./names.js";
import type { Problem } from "./problems.js";

export type Controller = "payer" | "worker" | "profile owner" | "program" | "rpc node";

export type Rule = "untrusted" | "sanitized" | "hashed" | "checked";

export type Carried = { readonly from: readonly Controller[]; readonly rule: Rule };

export type Source = "own" | Carried;

const payer = (rule: Rule): Carried => ({ from: ["payer"], rule });
const worker = (rule: Rule): Carried => ({ from: ["worker"], rule });
const profileOwner = (rule: Rule): Carried => ({ from: ["profile owner"], rule });
const LOGS: Carried = { from: ["program", "rpc node"], rule: "sanitized" };
const FAILURE: Carried = { from: ["rpc node", "program"], rule: "sanitized" };
const SIGNATURE: Carried = { from: ["rpc node"], rule: "checked" };

const DELIVERIES: Readonly<Record<string, Carried>> = { spec_hash: payer("hashed"), "announcements[].commitment": worker("hashed") };
const RECEIPT_CARRIED: Readonly<Record<string, Carried>> = { delivered_sha256: worker("hashed"), "held[].close": SIGNATURE };

export const CARRIED: Readonly<Record<string, Readonly<Record<string, Carried>>>> = {
  [tool("get_spec")]: { url: payer("sanitized"), text: payer("untrusted"), sha256: payer("hashed") },
  [tool("wallet_fetch_work")]: { url: worker("sanitized"), untrusted_text: worker("untrusted"), sha256: worker("hashed"), "first.commitment": worker("hashed") },
  [tool("find_jobs")]: { "jobs[].spec_url": payer("sanitized"), "jobs[].spec_hash": payer("hashed") },
  [tool("get_profile")]: { "skills[]": profileOwner("sanitized"), endpoint: profileOwner("sanitized"), doc_url: profileOwner("sanitized"), doc_sha256: profileOwner("hashed") },
  [tool("check_delivery")]: DELIVERIES,
  [tool("wallet_check_delivery")]: DELIVERIES,
  [tool("wallet_escrow_plan")]: { untrusted_detail: FAILURE, "pieces[].signature": SIGNATURE },
  [tool("wallet_recurring")]: { untrusted_detail: FAILURE, "orders[].signature": SIGNATURE },
  [tool("wallet_estimate")]: { "fills[].signature": SIGNATURE },
  [tool("wallet_claim_held")]: { "shares[].release": SIGNATURE, "claiming.release": SIGNATURE },
  [tool("wallet_history")]: { "activity[].signature": SIGNATURE, "work[].signature": SIGNATURE, "work[].release": SIGNATURE, "claims[].signature": SIGNATURE },
  [tool("get_receipt")]: RECEIPT_CARRIED,
  [tool("wallet_receipt")]: RECEIPT_CARRIED,
  [tool("prepare_create")]: { "prepared.logs[]": LOGS },
  [tool("prepare_cancel")]: { "prepared.logs[]": LOGS },
  [tool("prepare_deliver")]: { "prepared.logs[]": LOGS },
  [tool("prepare_crank")]: { "prepared.logs[]": LOGS },
  [tool("prepare_mandate")]: { "prepared.logs[]": LOGS },
  [tool("prepare_revoke_mandate")]: { "prepared.logs[]": LOGS, "cancels[].logs[]": LOGS },
  [tool("prepare_agent_create")]: { "prepared.logs[]": LOGS },
  [tool("prepare_signed_intent")]: { "setup.logs[]": LOGS },
};

export const COMMON_CARRIED: Readonly<Record<string, Carried>> = { signature: SIGNATURE };

export const COMMON_OWN: readonly string[] = [
  "next",
  "summary[]",
  "warnings[]",
  "approval",
  "message_hash",
  "digest",
  "skipped[].why",
  "skipped[].reason",
  "unreadable[].reason",
  "prepared.transaction",
];

const RECEIPT = ["paid", "stake_returned", "delivered_salt", "held[].amount", "withheld[].role", "withheld[].amount"];

export const OWN: Readonly<Record<string, readonly string[]>> = {
  [tool("wallet_setup")]: ["keypair", "url", "settings", "sol", "airdrop", "notice[]"],
  [tool("wallet_balance")]: ["sol", "tokens[].name", "tokens[].balance"],
  [tool("wallet_estimate")]: ["fills[].sold", "fills[].received", "receive_at_best", "receive_at_median", "receive_at_latest"],
  [tool("wallet_swap")]: ["min_receive", "start_receive"],
  [tool("wallet_recurring")]: ["start_receive", "min_receive"],
  [tool("wallet_escrow_plan")]: ["pieces[].name", "pieces[].amount", "pieces[].spec_hash", "pieces[].spec_url", "total"],
  [tool("wallet_seal_spec")]: ["sealed", "sha256", "sealed_sha256"],
  [tool("wallet_attest")]: ["paid", "fee", "delivered_sha256"],
  [tool("wallet_attest_split")]: ["envelope", "paid[].amount", "net", "fee", "delivered_sha256"],
  [tool("wallet_committee_vote")]: ["vote.signature"],
  [tool("wallet_deliver")]: ["sha256", "url", "commitment"],
  [tool("wallet_check_delivery")]: ["announcements[].state", "mine[].state"],
  [tool("wallet_fetch_work")]: ["refused.message"],
  [tool("wallet_refute")]: ["sha256"],
  [tool("wallet_reclaim")]: ["reasons[].reason"],
  [tool("wallet_claim_held")]: ["shares[].amount", "shares[].token", "claiming.amount", "claiming.token"],
  [tool("wallet_wait")]: ["received", "paid_out", "token"],
  [tool("wallet_receipt")]: RECEIPT,
  [tool("wallet_intents")]: ["intents[].summary[]"],
  [tool("wallet_history")]: [
    "activity[].kind",
    "activity[].sold",
    "activity[].sell_token",
    "activity[].received",
    "activity[].receive_token",
    "activity[].returned",
    "activity[].returned_in",
    "work[].amount",
    "work[].token",
    "work[].held",
    "work[].returned",
    "work[].returned_in",
    "claims[].stake",
    "profit.token",
    "profit.received",
    "profit.paid_out",
    "profit.fees",
    "profit.fees_sol",
    "profit.rent_sol",
    "profit.difference",
  ],
  [tool("wallet_unwrap")]: ["wrapped", "rent"],
  [tool("list_intents")]: ["intents[].summary[]"],
  [tool("get_balances")]: ["sol", "tokens[].balance_tokens"],
  [tool("find_jobs")]: ["jobs[].pays", "jobs[].net_pay", "jobs[].freeze_warning"],
  [tool("get_spec")]: ["text_warning", "freeze_warning"],
  [tool("hash")]: ["sha256"],
  [tool("prepare_deliver")]: ["sha256", "url", "commitment"],
  [tool("check_delivery")]: ["announcements[].state"],
  [tool("get_receipt")]: RECEIPT,
  [tool("get_reputation")]: ["reason", "backed_sol", "feedback.average", "records[].refuted_by", "trust.score", "trust.paths[].trust", "trust.reason"],
  [tool("get_profile")]: ["encryption_key"],
  [tool("prepare_signed_intent")]: ["message", "submit.spec_url", "setup.transaction"],
  [tool("prepare_revoke_mandate")]: ["cancels[].transaction"],
};

export const REFUSAL_FIELDS: { readonly [K in keyof Required<Problem>]: Source } = {
  code: "own",
  retryable: "own",
  hint: "own",
  programError: "own",
  program: "own",
  issues: "own",
  logs: LOGS,
  signature: SIGNATURE,
  untrustedDetail: { from: ["payer", "worker", "rpc node", "program"], rule: "sanitized" },
};

export function sourceOf(name: string, path: string): Source | undefined {
  const carried = CARRIED[name]?.[path] ?? COMMON_CARRIED[path];
  if (carried !== undefined) {
    return carried;
  }
  return COMMON_OWN.includes(path) || (OWN[name] ?? []).includes(path) ? "own" : undefined;
}
