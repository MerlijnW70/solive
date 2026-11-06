# Job: Every judge signature needs a passing run (judge-receipt)

**Rules:**
1. A judge signs a release, a committee vote or a release digest only for work that a judge run on the same machine passed against the same spec. The run records that pass as a receipt. This holds for the CLI and the MCP tools.
2. A receipt binds the escrow (owner, nonce and intent), the spec's sha256, the delivered sha256, the announcement it opens, the route that ran (with its engine or image pins, and the `judge-run` block when present), and the outcome `pass`. A receipt for anything else does not authorize a signature.
3. Signing without a receipt needs an explicit, named override, which is printed and recorded. No default, environment variable or config file turns it on.

Today `solive_wallet_attest` (`packages/cli/src/agent/wallet/attest.ts:212`), `solive_wallet_committee_vote` (`packages/cli/src/agent/wallet/committee.ts:97`) and the CLI `committee vote` (`packages/cli/src/commands.ts:273`) sign for an announced sha256 without any check having run. Only tool text asks the caller to judge first. `judge` without `--yes`, and the MCP `solive_wallet_judge_work`, report a pass but leave nothing a later signature can be bound to. `judge --verdict` writes a file at a path the caller chooses (`packages/cli/src/judge.ts:472`). These are examples only.

## Build

1. **Find every signing path.** List every CLI command, MCP tool and SDK path that produces a release, a committee vote, a cosign or a release digest. Include `attest`, committee vote and release, split attests, the Ledger and the key-file signers, and `judge` itself. Put the list in the report, with how each path is gated after your patch.
2. **The receipt.** One module writes and reads receipts.
   - The verdict model writes one on every `pass` outcome, from `judge` (with or without `--yes`, single and committee, `--watch`) and from `solive_wallet_judge_work`. Never on `fail` or `infra`.
   - Store receipts in a private per-user directory with mode 0700 for directories and 0600 for files, beside the wallet's existing config, keyed so that two escrows or two deliveries cannot collide.
   - Write each receipt atomically. Refuse symlinks and files not owned by the user.
   - Keep the existing `--verdict` output unchanged.
3. **The gate.** Every signing path from item 1, other than `judge` signing its own fresh pass, needs a receipt that matches every field from rule 2 for what it is about to sign. It checks this before any preview approval, Ledger prompt or send. A missing, mismatched, unreadable or tampered receipt is refused, with a reason that says how to get one: run `judge` or `solive_wallet_judge_work` first.
4. **The override.** Add one explicit option per surface: a CLI flag, and an MCP input whose value must be a non-empty reason. It prints a warning naming what was not checked, and it is recorded in the command's output. Follow the existing preview-then-send pattern; the override cannot be added between preview and send.
5. **Texts.** Update tool descriptions, next-hints and docs (`docs/judge.md`, `docs/mcp.md`, `docs/maintainers/judge-internals.md`) so that each says a signature needs a passing run, and names the override. Regenerate the reference docs.

## Tests

- **A table test of the matcher:** every receipt field mismatched once, a receipt for fail or infra, a missing file, a tampered file, a symlink, a wrong owner, and an unwritable directory.
- **Per signing path from item 1:** refused without a receipt, accepted with a matching one, accepted with the override, which is printed and recorded. Cover the CLI and MCP, single judge and committee, and key file and Ledger, the latter with the existing fake signer.
- **Writing:** `judge` without `--yes` and `solive_wallet_judge_work` write a receipt on pass, never on fail or infra, and a following `attest` or vote then succeeds.
- **The existing suites** of every package you change still pass. Where an existing test signed without a run, give it a receipt or the override and list it in the report; do not weaken an assertion.

## Self-check before delivering

A reviewer will attack your patch in these ways. Check each one yourself and report what you found:
- Find another route to the same hole: another entry point (CLI vs MCP vs SDK), the Ledger path, committee release, split attests, `--watch`, a digest-only path, or a preview made before the receipt existed and sent after it changed.
- Can a receipt for one escrow, spec, delivery or announcement authorize another? Try the same sha256 under another escrow, a re-announced delivery, and a spec changed after the run.
- Can the work or another local process plant a receipt? Try a world-writable directory, a symlink race and a path built from untrusted text.
- Can the override turn on implicitly?

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- No program change. A pass from `judge --yes` signs exactly as today.
- Rebase onto the latest local `main` of `F:\solive` right before delivering, and name the base commit.
- Never write to the shared git config, and never export `GIT_DIR` or `GIT_WORK_TREE` around test runs.
- Run the full test suite of each package you change, plus typecheck, lint and the docs checks. The judge runs the full CI.

## Report

- The signing-path list from item 1.
- The receipt format and location.
- Each changed existing test and why.
- The self-check findings.
- **Same defect elsewhere:** `path:line — why`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review confirms that no signing path signs without a matching receipt or the explicit override, and that the self-check attacks fail.

## Deliver

One `git format-patch` file plus the report. Announce its sha256 to the judge.
