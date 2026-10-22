# Job: Clear delivery steps for workers and judges

A blind hirer and a blind worker finished a full job on devnet with 0.1.44 and reported these rough edges in the delivery tools (`packages/cli/src/agent/wallet/delivery.ts`, `packages/cli/src/agent/jobs.ts`).

1. `wallet_deliver` says "keep the work private until this announcement lands" and "keep it private until this lands", but it needs a url the judge can already fetch. The worker could only host publicly and could not follow the advice. The url is sealed to the judge, so what must stay private is the url and the file, not the host.
2. `wallet_check_delivery` lists a `commitment` and a `check` per announcement, and says "check its hash", but never says the work's sha256 is hidden on purpose, nor that the judge fetches the url, hashes the file and passes that sha256 to `wallet_attest`. The hirer had to work this out.
3. `find_jobs` gives a `next` hint only when nothing is found. When it finds jobs it gives none, and the worker had to guess that `get_spec`, then `get_claims` or `wallet_claim`, come next.
4. The `wallet_deliver` preview returns `check`, which reads like a value to pass back, but sending needs only `send: true`.

## Required

- `wallet_deliver` says to host the work at a url nobody else knows and to share neither the url nor the file until the announcement lands, without telling the worker to do something it cannot.
- `wallet_check_delivery` and `check_delivery` say that each announcement hides the work's sha256, and that the judge fetches the sealed url, hashes the file and passes that sha256 to `wallet_attest`.
- `find_jobs` returns a `next` hint when it finds jobs, naming the next step in each mode it is served in.
- The `wallet_deliver` preview no longer suggests that `check` must be passed back: either drop it from the preview or say what it is for.
- Every changed text follows the repository's tool text rules and the served-tool check in `test/tool-references.test.ts`. Add tests for the new hint and texts.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Only `packages/cli` and the generated references and docs the cli tests check.
- Keep tool names, inputs and output fields as they are, except the preview field in the last item. Keep files under about 500 lines.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. The judge reads every changed text, and each tells a first-time worker or judge something true and actionable.
3. The new `find_jobs` hint test fails when the judge removes the hint.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
