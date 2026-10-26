# Bounty: the multisig review of program and idl changes (critical)

This escrow pays 1.0 SOL for one critical finding against the invariants below: a test that fails on the base commit and shows an invariant does not hold. It is part of verification round H16, aimed at the code that changed since round H14: held split shares, the claim cooldown on every path, mandate checks, the multisig review of IDL updates and the SDK's held-share reads.

## Scope

packages/multisig/src: review.ts, program-metadata.ts, program-metadata-layout.ts, squads.ts (approve, execute, --expect-buffer-hash), main.ts; scripts/idl.sh --multisig and scripts/instruction-list.mjs as they build a proposal.

## Invariants

- **MS-1**: The review never describes an instruction as an update of the intent engine's IDL, or as harmless, when it changes other metadata, hands an authority to a key other than the vault, sends closed lamports outside the vault, changes program code or the upgrade authority, or moves vault funds; and approve and execute refuse or require the flag exactly as the review says.
- **MS-2**: The buffer hash the review shows and execute --expect-buffer-hash compares is the sha256 of exactly the bytes the executed transaction will set, for loader buffers and for program-metadata buffers through every encoding and compression.
- **MS-3**: A proposal whose message the review cannot fully decode (lookup tables, malformed data, unknown programs signed by the vault) is never approved or executed without the explicit flag the review names.

## What a critical finding is

Funds paid to the wrong party, funds lost or locked beyond the escrow's normal refund path, a release the attestor (or committee quorum) never signed, or a multisig action the review did not show. The judge decides the tier; a finding of a higher tier is paid from that tier's escrow, a lower one from its own.

## Rules for a finding

- It uses only what an unprivileged party can do: any number of its own wallets, any transaction they can sign, any content it serves at its own urls, any announcement it can build. It does not hold the escrow owner's, the attestor's, a committee member's, a multisig member's or the admin's keys (for the multisig area: a proposal any member could create, reviewed by the tool before another member approves it), and it does not control the RPC node of the party whose invariant breaks.
- It reaches its state through transactions the program accepts, never by writing account data.
- These are known and do not pay: anything already listed in docs/maintainers/threat-model.md or the catalog tables in docs/maintainers/ as mitigated, accepted or partial; a judge paying a later announcer (refutable by design); an owner cancelling after seeing announcements; announcement rent being a refundable lockup; a mint's freeze authority (T-83); intents a revoked or re-epoched mandate opened becoming unfillable while staying refundable to the owner; the two-wallet claim renewal while nobody waits in the line; reputation and held-share scans cut off by the history page limit when they report `complete: false`.
- One finding per escrow; the earliest valid announcement of a delivery is paid.

## Gate

Add one file packages/multisig/test/hunt/ms-<short-name>.test.ts (vitest, the multisig package and its test helpers, including its LiteSVM world). Each failing test's title starts with the invariant id, for example `MS-1 shows ...`. The judge runs node node_modules/vitest/vitest.mjs run test/hunt/(your file) in packages/multisig three times on the base commit: the same tests must fail every time on an `expect` assertion, not on a thrown setup error. The file must not mock modules of packages/multisig, packages/client or packages/core, edit account data, or change any file outside it.

## Deliver

One `git format-patch` file that adds only your test file, made against `main` at the commit the delivery names, with a short report: the invariant, the sequence in plain words, why an unprivileged party can reach it, and the money or standing at stake. Announce its sha256 to the judge. A paid finding is fixed in a separate job.
