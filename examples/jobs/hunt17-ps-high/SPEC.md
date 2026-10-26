# Bounty: the multisig review of what a proposal sets (high)

This escrow pays 0.4 SOL for one high finding against the invariants below: a test that fails on the base commit and shows an invariant does not hold. It is part of verification round H17, aimed at the code that changed since round H16: the claim cooldown and stake floor, overflow-free deadlines and the multisig review of what a proposal sets.

## Scope

packages/multisig/src: post-state.ts, proposal-effects.ts, review.ts, squads.ts (approve, execute, --expect-buffer-hash, --allow-rewritten-buffer), chain.ts (simulate), program-metadata.ts; scripts/idl.sh --multisig and scripts/deploy.sh --multisig as they build proposals.

## Invariants

- **PS-1**: When execute sends a vault transaction, the IDL and program code it sets hash exactly to what --expect-buffer-hash names, and approve's post_state shows what execute would set; a proposal whose effect differs is refused before anything is sent.
- **PS-2**: Every instruction of a proposal that writes an account a later instruction reads is either computed exactly or blocks approval without --allow-rewritten-buffer, whatever the order, duplication or account roles in the message.
- **PS-3**: Simulation never makes the tool approve or execute something it would otherwise refuse: a failed, partial or misleading simulation (an account not read back, a lookup table, a different signer set) is a refusal, never a pass.

## What a high finding is

An invariant break without direct loss: for example a third party blocking a payout until expiry at low cost, a wrong refusal of a valid release, a claim or mandate limit that does not hold, or an SDK read that misstates who was paid. The judge decides the tier; a finding of a higher tier is paid from that tier's escrow, a lower one from its own.

## Rules for a finding

- It uses only what an unprivileged party can do: any number of its own wallets, any transaction they can sign, any content it serves at its own urls, any announcement it can build. It does not hold the escrow owner's, the attestor's, a committee member's, a multisig member's or the admin's keys (for the multisig area: a proposal any member could create, reviewed by the tool before another member approves it), and it does not control the RPC node of the party whose invariant breaks.
- It reaches its state through transactions the program accepts, never by writing account data.
- These are known and do not pay: anything already listed in docs/maintainers/threat-model.md or the catalog tables in docs/maintainers/ as mitigated, accepted or partial; a judge paying a later announcer (refutable by design); an owner cancelling after seeing announcements; announcement rent being a refundable lockup; a mint's freeze authority (T-83); intents a revoked or re-epoched mandate opened becoming unfillable while staying refundable to the owner; the two-wallet claim renewal while nobody waits in the line; reputation and held-share scans cut off by the history page limit when they report `complete: false`.
- One finding per escrow; the earliest valid announcement of a delivery is paid.

## Gate

Add one file packages/multisig/test/hunt/ps-<short-name>.test.ts (vitest, the multisig package and its test helpers, including its LiteSVM world). Each failing test's title starts with the invariant id, for example `PS-1 shows ...`. The judge runs node node_modules/vitest/vitest.mjs run test/hunt/(your file) in packages/multisig three times on the base commit: the same tests must fail every time on an `expect` assertion, not on a thrown setup error. The file must not mock modules of packages/multisig, packages/client or packages/core, edit account data, or change any file outside it.

## Deliver

One `git format-patch` file that adds only your test file, made against `main` at the commit the delivery names, with a short report: the invariant, the sequence in plain words, why an unprivileged party can reach it, and the money or standing at stake. Announce its sha256 to the judge. A paid finding is fixed in a separate job.
