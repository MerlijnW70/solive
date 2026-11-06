# Job: Fair closing in the SDK, CLI and MCP tools (fair-close-cli)

The on-chain part of fair closing (design D3) is built and reviewed in job `fair-close`. Its patch is `F:\solive-kit\kill-wave\fair-close\delivery.patch`, sha256 `f1320a09a12e8df137cc8a5d560da7dced9fb8be34127aeb580d6fdbd0d5854a`. This job makes `packages/client`, `packages/cli` and the docs use it, so that the combined change passes the full CI. The design is `F:\solive-kit\outside-jobs\fair-close-design\out\design.md` (sha256 `98c0d155f8982409a75da60f4b67a41089367a88dde21f1d113faf42cb72ae67`); its section 6.4 and the decisions in the `fair-close` spec are the bar.

**Rules:**
1. Every hirer, worker and judge flow in the SDK, CLI and MCP tools works against the new program, with no flow broken.
2. A worker always sees, before acting, whether a job protects them: the review window, the kill fee, and whether the review will arm. A hirer always sees the notice and review they are bound by.
3. Behaviour that the new program refuses is never attempted blindly. Every refusal a user can meet has a clear next step.

## Build

1. **Start from the program patch.** Apply the `fair-close` patch to the base commit. Your delivery is one commit on top of it. Deliver both patches in order, and do not change the program patch.
2. **Shipped program.** Build the new program and ship it as `packages/client/program/intent_engine.so`. Update every pin or record of the shipped program hash in tests and docs to the new build, so that it matches. Do not touch devnet, `monitoring/devnet.json` or any deploy step: the owner deploys, and `monitoring/devnet.json` changes then.
3. **Two-step cancel.** In the SDK, CLI and MCP, cancelling an escrow that has an announcement means a request, then the notice, then the cancel:
   - show the time left;
   - run every existing cancel and reclaim flow through it;
   - keep the immediate cancel for escrows without an announcement.
4. **Review terms.**
   - Hirer side: `open_claims`, escrow creation with claims and the claims tools take `review_secs` and `kill_fee`. The CLI and MCP defaults are a review window of `86_400` seconds and a kill fee equal to the stake, as design 5.7 proposes.
   - Escrow creation and opening claims happen in one transaction, so nobody can announce in between and lock out claims (design attack AH5).
   - The worker side shows protection before claiming and before announcing. It warns when a holder served from the line, or a late claim, will not arm a review.
5. **Judge reject.** Add a `reject` judge path in the CLI, and add an MCP tool or an existing tool's option, for a key judge and for a committee threshold. It is gated by the same receipt-and-override rules as other judge signatures (`packages/cli/src/receipt-gate.ts`), with a run that ended in fail as its basis. Extend the receipt to record a fail for this purpose only if needed, and keep every rule of the judge-receipt job.
6. **Collect.** Add a worker step, in the CLI and MCP, that collects a lapsed review (stake plus kill fee) through `settle_claims` or `cancel_intent`. It is offered when `review_until` has passed.
7. **Reads.** `find_jobs`, `get_claims`, history, receipts and the live feed show:
   - `review_secs`, `kill_fee` and the review state;
   - the new events (`ReviewArmed`, `DeliveryRejected`, `ReviewLapsed`, the notice event);
   - `ClaimDropped`'s new `announcement` field.

   Old on-chain events without that field must still decode, and none may be silently skipped. Check `packages/cli/src/agent/wallet/history-work.ts:192`.
8. **Fallout listed by the program worker.** Fix all of these:
   - `packages/client/test/mint-caps.test.ts:94` (index -3 to -4);
   - `packages/client/test/roles.test.ts:317` (the generated cancel builder needs `book`);
   - every cancel-after-announcement flow in client and cli tests;
   - `packages/cli/test/kill-cli-wallet-survivors-kit.ts:49` and `packages/cli/test/wallet-history-work.test.ts:176` (the event field).
9. **Docs and texts.** Update the guides, the MCP tool descriptions and next-hints, the error hints in `packages/cli/src/agent/problems.ts`, and the generated reference. Each should say what protection a job gives and how cancel, reject and collect work.

## Tests

- **End to end on LiteSVM through the real SDK and CLI or MCP**, one test per flow:
  - hire with review terms;
  - claim, announce and see the review armed;
  - judge pass;
  - judge reject;
  - lapse and collect;
  - request cancel, then the notice, then cancel;
  - cancel without an announcement;
  - an old v1 book.
- **Decoding:** old and new event layouts both decode.
- **Defaults:** the CLI and MCP defaults from item 4.
- **The existing suites** of every package pass. Do not weaken any assertion; list each changed test and why.

## Self-check before delivering

- Find another route to the same hole: a hirer flow that still cancels in one step after an announcement, a worker flow that claims or announces without seeing protection, a judge flow that rejects without the receipt gate, or a read that drops the new events.
- Can the one-transaction create-and-open-claims be split by any path?
- Are Ledger signers covered for request cancel and reject?

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Do not change the program, intent-core, or the program patch. Do not deploy, and do not touch devnet, keys, wallets or the multisig.
- Rebase onto the latest local `main` of `F:\solive` right before delivering, and name the base commit.
- Never write to the shared git config, never export `GIT_DIR` or `GIT_WORK_TREE` around test runs, and never add a `Signed-off-by` line.
- Run the full test suite of each package you change, plus typecheck, lint and the docs checks.

## Report

- The flow list and its tests.
- Each changed existing test and why.
- The self-check findings.
- **Same defect elsewhere:** `path:line — why`.

## Acceptance

1. `bash scripts/ci.sh` passes with the `fair-close` patch and this patch applied, in order, to `main` at the commit the delivery names.
2. A review confirms rules 1 to 3 on every flow.

## Deliver

One `git format-patch` file for this job's commit, plus the report. Announce its sha256 to the judge.
