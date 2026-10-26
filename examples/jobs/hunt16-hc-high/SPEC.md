# Bounty: held shares in the sdk (high)

This escrow pays 0.4 SOL for one high finding against the invariants below: a test that fails on the base commit and shows an invariant does not hold. It is part of verification round H16, aimed at the code that changed since round H14: held split shares, the claim cooldown on every path, mandate checks, the multisig review of IDL updates and the SDK's held-share reads.

## Scope

packages/client/src: held-shares.ts, held-claim.ts, release-holds.ts, receipts, reputation and work records as they count held shares, and the client's claimHeld send and plan; packages/core builders for claim_held.

## Invariants

- **HC-1**: client.heldShares(wallet) lists exactly the shares still held for that wallet, with the amounts the release computed, and never a share already claimed, one held for another wallet, or one taken from a split the program did not execute.
- **HC-2**: client.claimHeld sends exactly the claim its plan showed, for the wallet's own share, and refuses when the share, the split or the receiving account differ from the plan.
- **HC-3**: Receipts, reputation and work records count a held share as paid to its co-author but not received until claimed, and a claimed share as received, never twice and never for the wrong wallet.

## What a high finding is

An invariant break without direct loss: for example a third party blocking a payout until expiry at low cost, a wrong refusal of a valid release, a claim or mandate limit that does not hold, or an SDK read that misstates who was paid. The judge decides the tier; a finding of a higher tier is paid from that tier's escrow, a lower one from its own.

## Rules for a finding

- It uses only what an unprivileged party can do: any number of its own wallets, any transaction they can sign, any content it serves at its own urls, any announcement it can build. It does not hold the escrow owner's, the attestor's, a committee member's, a multisig member's or the admin's keys (for the multisig area: a proposal any member could create, reviewed by the tool before another member approves it), and it does not control the RPC node of the party whose invariant breaks.
- It reaches its state through transactions the program accepts, never by writing account data.
- These are known and do not pay: anything already listed in docs/maintainers/threat-model.md or the catalog tables in docs/maintainers/ as mitigated, accepted or partial; a judge paying a later announcer (refutable by design); an owner cancelling after seeing announcements; announcement rent being a refundable lockup; a mint's freeze authority (T-83); intents a revoked or re-epoched mandate opened becoming unfillable while staying refundable to the owner; the two-wallet claim renewal while nobody waits in the line; reputation and held-share scans cut off by the history page limit when they report `complete: false`.
- One finding per escrow; the earliest valid announcement of a delivery is paid.

## Gate

Add one file packages/client/test/hunt/hc-<short-name>.test.ts (vitest, the repository's client package; the test world from `../../src/testing.js` and the existing test helpers may be used). Each failing test's title starts with the invariant id, for example `HC-1 lists a share ...`. The judge runs node node_modules/vitest/vitest.mjs run test/hunt/(your file) in packages/client three times on the base commit: the same tests must fail every time on an `expect` assertion, not on a thrown setup error. The file must not mock modules of packages/client or packages/core, edit account data, or change any file outside it.

## Deliver

One `git format-patch` file that adds only your test file, made against `main` at the commit the delivery names, with a short report: the invariant, the sequence in plain words, why an unprivileged party can reach it, and the money or standing at stake. Announce its sha256 to the judge. A paid finding is fixed in a separate job.
