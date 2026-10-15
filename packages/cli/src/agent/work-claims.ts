import { createHash } from "node:crypto";
import type { Address } from "@solana/kit";
import { buildClaimJob, buildDropClaim, claimUntil, findIntentPda, formatAmount, IntentCoreError, IntentStatus, MAX_CLAIM_SECS } from "@intent-engine/core";
import { createClient } from "@intent-engine/client";
import { coolingDown, heldBy, noClaims } from "../claim-commands.js";
import { type AgentContext, define } from "./actions.js";
import type { Call } from "./claims.js";
import { tool } from "./names.js";
import { AgentRefusal } from "./problems.js";
import { account, amount, choice, flag, InvalidInput, integer, list, nullable, object, optional, text, time } from "./schema.js";
import { preparedView } from "./shapes.js";
import { prepare } from "./prepare.js";
import { signerOf, sent } from "./wallet/guard.js";

export const CLAIM_CHANGED =
  "this claim differs from its preview: the escrow, action, seconds or stake changed, or no approval was given; preview it again and show the user";

const escrowRef = {
  owner: account("the wallet that made the escrow"),
  nonce: amount("the escrow intent's nonce"),
};

async function claimsFor(ctx: AgentContext, owner: Address, nonce: bigint) {
  const client = createClient({ url: ctx.url ?? "", transport: ctx.transport });
  const [intent] = await findIntentPda({ owner, nonce });
  return { client, intent, view: await client.claims(owner, nonce) };
}

export const getClaims = define({
  name: tool("get_claims"),
  title: "Who holds a job's claim",
  description: `Read the claims board of a proof escrow: whether its owner opened claims, and whether the job is free, held by a worker until a time, or held by a claim that lapsed. While a claim holds, only its worker can be paid. A worker claims or drops it with ${tool("wallet_claim")}.`,
  effect: "read",
  input: object(escrowRef),
  output: object({
    intent: account(),
    takes_claims: flag("false means the owner opened no claims, so anyone can be paid"),
    board: optional(account()),
    state: optional(choice(["free", "held", "lapsed"] as const)),
    worker: optional(nullable(account())),
    until: optional(time("when the claim lapses")),
    seconds_left: optional(amount("seconds until the claim lapses, by the chain's clock")),
    stake: optional(amount("lamports a worker stakes to claim")),
    max_secs: optional(integer(1, MAX_CLAIM_SECS, "the longest a claim may run")),
    owner: optional(account()),
    dropped_by: optional(nullable(account("a worker that dropped its claim and may not claim again until cooldown_until"))),
    cooldown_until: optional(time("when the worker that dropped may claim again")),
  }),
  run: async (ctx, input) => {
    const { intent, view } = await claimsFor(ctx, input.owner, input.nonce);
    if (view === null) {
      return { intent, takes_claims: false };
    }
    return {
      intent,
      takes_claims: true,
      board: view.board,
      state: view.state,
      worker: view.worker,
      until: view.until,
      seconds_left: view.secondsLeft,
      stake: view.stake,
      max_secs: view.maxSecs,
      owner: view.owner,
      dropped_by: view.cooldown?.worker ?? null,
      ...(view.cooldown === null ? {} : { cooldown_until: view.cooldown.until }),
    };
  },
});

export const walletClaim = define({
  name: tool("wallet_claim"),
  title: "Claim or drop a job",
  description: `As a worker, claim a proof escrow's job for secs seconds by staking what its owner asks, so that only this server's wallet can be paid until the claim lapses; or drop a claim it holds to take the stake back. The stake returns when a release pays this wallet, and goes to the owner if the claim lapses first. Read the board with ${tool("get_claims")}. Without send it only previews; show the user the summary and, once they approve, call again with send: true and the approval the preview returned.`,
  effect: "submit",
  input: object({
    ...escrowRef,
    action: choice(["take", "drop"] as const, "take claims the job, drop gives up a claim this wallet holds"),
    secs: optional(integer(1, MAX_CLAIM_SECS, "how long to hold the claim; needed with take")),
    approval: optional(text("the approval the preview returned; needed with send")),
    send: optional(flag("true sends the claim; leave out to preview")),
  }),
  output: object({
    intent: account(),
    action: choice(["take", "drop"] as const),
    approval: text(),
    summary: list(text(), 4),
    sent: flag(),
    signature: optional(text()),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const signer = await signerOf(ctx);
    const { client, intent, view } = await claimsFor(ctx, input.owner, input.nonce);
    if (view === null) {
      throw new AgentRefusal("ClaimsMissing", noClaims(intent));
    }
    const stake = `${formatAmount(view.stake, 9)} SOL`;
    let instruction;
    let summary: string[];
    if (input.action === "take") {
      if (input.secs === undefined) {
        throw new InvalidInput([{ path: "secs", message: "give secs with action take" }]);
      }
      if (view.state === "held" && view.worker !== null) {
        throw new AgentRefusal("ClaimHeld", heldBy(intent, view.worker, view.secondsLeft));
      }
      if (view.cooldown !== null && view.cooldown.worker === signer.address) {
        throw new AgentRefusal("ClaimCooldown", coolingDown(intent, signer.address, view.cooldown.until));
      }
      if (input.secs > view.maxSecs) {
        throw new InvalidInput([{ path: "secs", message: `this escrow allows at most ${view.maxSecs} seconds` }]);
      }
      const now = await client.chainTime();
      const found = await client.intent(input.owner, input.nonce);
      if (found === null || found.intent.status !== IntentStatus.Open || now >= found.intent.expiresAt) {
        throw new AgentRefusal("InvalidTransition", `escrow ${intent} is no longer open, so its job cannot be claimed`);
      }
      let until: bigint;
      try {
        until = claimUntil(view.maxSecs, now, input.secs, found.intent.expiresAt);
      } catch (error) {
        throw error instanceof IntentCoreError ? new AgentRefusal("ClaimTerms", `a claim of ${input.secs} seconds would outlive escrow ${intent}`) : error;
      }
      instruction = await buildClaimJob({ worker: signer, intent, owner: view.owner, secs: input.secs });
      summary = [
        `Claims: escrow ${intent} until ${until}, ${input.secs} seconds; until then only this wallet ${signer.address} can be paid`,
        `Stakes: ${stake}, returned when a release pays this wallet or it drops the claim, and lost to the owner if the claim lapses first`,
      ];
    } else {
      if (view.state !== "held" || view.worker !== signer.address) {
        throw new AgentRefusal("NotClaimant", `this wallet ${signer.address} holds no claim on escrow ${intent}`);
      }
      instruction = await buildDropClaim({ worker: signer, intent });
      summary = [`Drops: this wallet's claim on escrow ${intent}`, `Returns: its stake of ${stake} to ${signer.address}`];
    }
    const approval = createHash("sha256").update(`${intent}:${input.action}:${input.secs ?? ""}:${view.stake}`).digest("hex").slice(0, 16);
    if (input.send === true && input.approval !== approval) {
      throw new AgentRefusal("ReleaseChanged", CLAIM_CHANGED);
    }
    const shown = {
      intent,
      action: input.action,
      approval,
      summary,
      prepared: input.send === true ? preparedView(await prepare(ctx.transport, [instruction], signer.address)) : undefined,
    };
    return sent(ctx, signer, shown, input.send, call);
  },
});
