# Job: Release previews show what the program will really pay (D7)

The deep audit (A3-01, A3-15, A1 L30) found that release previews promise a judge or partner fee the program withholds, and that the release fee math is written three times.

## Build

1. **Withheld fees are shown.** The program pays a judge, partner or agent fee only into a canonical token account that passes its strict receive rule (`can_receive` in `programs/intent_engine/src/policy.rs`); a frozen account or one with an extension other than ImmutableOwner, a CPI guard included, gets nothing, and the fee is swept to the owner at close. The protocol leg uses the looser `accepts_payout`. The previews in `packages/client/src/release-plan.ts`, `packages/cli/src/agent/wallet/attest.ts` and `packages/cli/src/agent/wallet/split.ts` never check, and the CLI prints "Pays the judge" unconditionally. Read the judge and partner accounts before signing and apply the same rule the program applies, so the preview says which fee is paid and which is withheld, and to whom it goes instead.
2. **One release preview.** Compute the release amounts, fee legs and payee accounts in one client function and use it from all three places, so they cannot drift. The CLI split path should settle through the client rather than building the instruction itself, unless there is a concrete reason, stated in the delivery.
3. **Do not change the program.** Whether judge and partner should use the looser rule is a separate decision; this job only makes the previews true.

## Tests

Each item has a test that fails without its fix: with a judge account that has a CPI guard, and one that is frozen, the client preview lists the judge fee as withheld and the CLI preview does not say "Pays the judge"; the same for a partner fee; a normal account still shows the fee paid; the three call sites give identical figures for one escrow.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only `packages/client` release files (`release-plan.ts`, a new preview file if needed), `packages/cli/src/agent/wallet/attest.ts`, `split.ts`, their tests and generated references. No program change.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
