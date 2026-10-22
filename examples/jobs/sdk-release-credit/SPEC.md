# Job: Simple SDK releases that credit the worker, and escrow plans workers can find

Two gaps leave paid work without credit or without workers.

1. `release()` in the simple client (`packages/client/src/simple-work.ts`) calls `settleProof` without `deliveredSalt` and takes `to` on trust. `releaseStandingOf` (`packages/client/src/delivery-openings.ts`) marks every release without a salt as not valid, so the worker gets no reputation, and nothing checks that `to` is the first worker who announced that work. The CLI judge does both (`packages/cli/src/judge.ts`).
2. `wallet_escrow_plan` (`packages/cli/src/agent/wallet/escrow.ts`) has no `spec_hash` or `spec_url`, so its escrows never show in `find_jobs`. A `wallet_escrow` without `spec_hash` is just as invisible, and nothing says so.

## Required

- `release()` finds the delivery record of the escrow, takes the earliest announcement that opens with `deliveredSha256`, and pays its worker with its salt. If `to` is given and is not that worker, it refuses and names the worker who announced first. If no announcement opens, it refuses and says what is missing. The preview shows the worker and the announcement.
- The simple client gains `deliveries({ escrow })` (each announcement: worker, sha256, url, whether it opened, signature) and `receipt({ escrow })` (the release, payee, delivered sha256 and whether the release is valid), built on the reads the full client already has. Document both in `docs/sdk.md` in the style already there.
- `wallet_escrow_plan` accepts `spec_hash` and `spec_url` for the whole plan and for each piece, with the same checks as `wallet_escrow`. A piece's own values win over the plan's.
- `wallet_escrow` and `wallet_escrow_plan` previews say plainly when an escrow has no `spec_hash`, so workers cannot find it with `find_jobs`.
- Update `examples/openclaw/intent-engine/SKILL.md` where it recommends `wallet_escrow_plan` so it passes the spec.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Only `packages/client`, `packages/cli/src/agent/wallet`, their tests, `docs/sdk.md`, the generated references the tests check, and the SKILL file above.
- No program change. Keep public exports, commands and tool names; new fields are optional.
- Keep files under about 500 lines.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A LiteSVM test: a worker announces and opens, a simple-client `release()` pays them, and `releaseStandingOf` reports the release as valid with reputation credited to that worker.
3. Tests that `release()` refuses a `to` that is not the first announcer, and refuses when nothing opens.
4. A test that a plan piece with `spec_hash` and `spec_url` is listed by the same scan `find_jobs` uses, and that a preview without `spec_hash` carries the warning.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
