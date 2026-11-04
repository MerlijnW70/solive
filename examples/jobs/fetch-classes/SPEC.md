# Job: One rule decides whether a spec or work fetch may be retried (F2)

The deep audit (A2 A3, A12 patterns, C11) found that a rate-limited spec or work host is reported as "do not retry", that two copies of the retry rule have drifted, and that the fetch paths check urls and sizes differently.

## Build

1. **Rate limits are temporary.** The client throws `answered ${status}` for any non-OK status (`packages/client/src/spec-fetch.ts`). `PERMANENT_SPEC` (`agent/spec.ts`) and `PERMANENT_WORK` (`agent/wallet/work.ts`) match any 4xx, so 408 and 429 become `SpecUnfetchable` / `WorkUnfetchable`, whose hint says not to retry. Treat 408 and 429 as temporary.
2. **One classifier.** Replace both patterns with one shared permanent/temporary classifier in a new helper file, used by `get_spec`, `wallet_fetch_work`, `wallet_judge_work` and `delivery-fetch.ts`. Prefer a typed status from the client over matching message text where the client already gives one.
3. **One fetch check.** `fetchDelivery` repeats the url checks of `fetchBytes` in `delivery-fetch.ts` and drops the `cause`. `fetchSha256` there is used only by tests, so tests exercise `fetchBytes` and not `fetchDelivery`. Share one url check, keep the cause, and test the path production uses. State the size cap of each path in one place. The CLI watch and the MCP tools use different caps (`agent/wallet/work.ts`, `agent/wallet/judge-work.ts`). Keep the caps unless a test shows a reason to change them, and name them in the tool texts.

## Tests

Each item has a test that fails without its fix:
- `get_spec` and `wallet_fetch_work` against a host answering 429 return the retryable code and hint.
- A host answering 404 still returns the permanent code.
- `fetchDelivery` refuses a private url and keeps the cause.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only these files, plus their tests and generated references:
  - `packages/cli/src/agent/spec.ts`
  - `packages/cli/src/agent/wallet/work.ts`
  - `packages/cli/src/agent/wallet/judge-work.ts`
  - `packages/cli/src/delivery-fetch.ts`
  - `packages/cli/src/fetch-failure.ts`
  - one new helper file
  - the fetch rows of `packages/cli/src/agent/problems.ts`
  - `packages/client/src/spec-fetch.ts`, only to expose a typed status
- Another job edits other rows of `problems.ts`; rebase on main before delivering. No program change.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
