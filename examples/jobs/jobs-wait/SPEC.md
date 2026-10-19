# Job: let a worker wait for a job

A worker with nothing to do calls `solive_find_jobs` again and again until a job appears.

## Build

- `solive_find_jobs` takes an optional `wait`, in seconds, at most the `WAIT_MAX` the receipt tools use. With `wait` and no matching job, it reads again until a matching job appears or the time is up, then returns the same output as today.
- Without `wait`, the tool behaves exactly as today.
- When the time runs out with no job, `next` says so and that calling again with `wait` keeps waiting.

## Rules

- Reuse `poll` from `packages/cli/src/agent/wallet/wait.ts` and the clock the receipt tools use; tests use the fake clock and never sleep for real.
- Each read is fresh, never a cached answer.
- Tool descriptions stay short: add at most one sentence.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed.
- Regenerate `docs/reference`. Change only `packages/cli` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests cover: a job already open, a job opened during the wait, none by the end, `wait` with the `mint` and `min_pay` filters, `wait` above the maximum refused, and the tool unchanged without `wait`.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
