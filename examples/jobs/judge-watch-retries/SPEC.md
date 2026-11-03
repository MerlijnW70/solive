# Job: judge --watch retries what is temporary and stops when told (D11)

The deep audit of the CLI (A2 C2, C3, C4, C5, C6, C12) found these faults in the judge's watch mode.

## Build

1. **Temporary work failures are retried.** In watch mode any non-OK status, timeout or reset from the work host becomes `DeliveryUnfit` and the delivery is never judged again (`packages/cli/src/delivery-fetch.ts`, `judge-watch.ts`), while MCP treats the same failure as retryable. Classify permanent and temporary failures with one shared rule and defer temporary ones.
2. **A temporary spec outage is deferred.** `checkInvited` throws `SpecUnreadable`, whose hint says try again, but `judge()` maps it to a refusal (`judge.ts`). Defer it.
3. **Infrastructure retries are capped.** A check that times out or exits with an infrastructure code is downloaded and run again every interval without limit. Cap deferrals per delivery, then report and skip it.
4. **Ctrl-C stops a release before its check.** The watch has its own signal handler, and `judge()` holds signals only from late in its run, so a signal during the sandbox pull, the invite fetch or the beacon draw does not stop a send with `--yes`. Pass the watch's abort signal into `judge()`, check it before sending, and make the beacon sleep abortable.
5. **The preview simulates with the fee payer.** With `--fee-payer`, the release simulation runs without the payer, so a judge without SOL sees a failing preview for a send that would succeed (`release-simulation.ts`). Pass the payer through.
6. **One spec-hash check.** The spec-hash check is written in `judge.ts` and `judge-watch.ts`, and only one gives the resaved-file hint. Use one.

## Tests

Each item has a test that fails without its fix: a work host answering 503 then 200 gets judged; a spec url failing once is retried; repeated timeouts are skipped with a report after the cap; a signal during the sandbox pull sends nothing; `--fee-payer` with an empty judge wallet previews a passing simulation; both paths give the resaved hint.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only `packages/cli/src/judge.ts`, `judge-watch.ts`, `judge-errors.ts`, `delivery-fetch.ts`, `release-simulation.ts`, `draw.ts`, a shared fetch classifier if needed, and their tests. Do not touch `agent/wallet/attest.ts` or `split.ts`. No program change.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
