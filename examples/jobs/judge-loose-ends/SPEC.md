# Job: Judge loose ends from the verdict, receipt and fair-close rounds (judge-loose-ends)

**Rule:** what the judge, its tools and its docs say is true, and every money gate has a test that fails when the gate is removed.

The judge improvement rounds of 2026-11-06 left the items below. For each item, confirm it against the current code first. If an item is already fixed or wrong, say so with evidence and move on.

## Build

1. **`judge --watch` prints refusals as `fail`.** A refusal (exit 2) or an infra outcome (exit 75) must be printed as what it is, never as a fail, in text and JSON output alike. Use the outcome names from `packages/cli/src/verdict-model.ts`.
2. **`answerTooLong` in `packages/cli/src/draw.ts` is still a `JudgeRefused`.** Decide by the verdict model whether a drawn answer that is too long is the work's fault (fail) or a refusal, and route it through the one classifier. Explain the decision.
3. **The out-of-memory infra text** (`oomInfra` or its successor) tells the user to raise `--sandbox-memory`. Check that this advice is correct under the current verdict model, and that it never appears when the memory is pinned. Fix the text if not.
4. **The SDK `publishSpec` and the `solive_hash` tool do not validate a spec's `judge-run` block.** A hirer can pin a spec the judge will refuse. Make both run the same spec preflight that `judge` runs on a `judge-run` block, and refuse with that reason. Keep the behaviour for specs without a block unchanged.
5. **`docs/mcp.md`:**
   - It still says the judge "runs the spec check" where that is not what happens. Make it match the code.
   - Where it names constants instead of readable values, write the values, for example the spec read size and time limits, and add a test that ties each written value to its constant.
6. **Tests for money gates.** Add a test for each of these, and check that each fails when its gate is removed:
   - **M23:** a co-author of a committee release who is not a member cannot self-sign without a receipt.
   - **M24:** an override is bound into the split release approval.
   - **R4:** `reject` refuses when the announcement cannot be opened.
   - **W1:** `solive_wallet_worker` refuses an approval that was tampered with.
   - **F1:** the `notBefore` = `seen.asked` bound in the pinned judge run.
7. **Docs, pinned timeout headroom.** Say that a `judge-run` block's `timeout` counts the container's setup, so a spec should pin it with headroom. Put this in the docs that describe the block.

## Tests

As listed above. The existing suites of every package you change still pass. Do not weaken any assertion or raise any timeout.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines. Use `performance.now()` for any new wait.
- No program change. No change to any money rule, only tests and truthful output.
- Do not touch `packages/cli/src/node-judge.ts`, `packages/cli/src/node-runner.ts` or the plain Node sections of `docs/maintainers/judge-internals.md`. Another job owns them.
- Rebase onto the latest local `main` of `F:\solive` right before delivering, and name the base commit.
- Never write to the shared git config, never export `GIT_DIR` or `GIT_WORK_TREE` around test runs, and never add a `Signed-off-by` line.
- Run the full test suite of each package you change, plus typecheck, lint and the docs checks.

## Report

- Per item: what you confirmed, what you changed, and the test name.
- For item 6: the test and its mutant, and that the mutant fails.
- **Same defect elsewhere:** `path:line — why`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review confirms each item, and that each new money-gate test kills its mutant.

## Deliver

One `git format-patch` file plus the report. Announce its sha256 to the judge.
