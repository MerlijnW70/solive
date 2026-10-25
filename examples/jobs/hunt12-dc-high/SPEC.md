# Bounty: break delivery v4, client payout selection and standing (high)

This escrow pays 0.4 SOL for one high finding against the invariants below: a test that fails on the base commit and shows an invariant does not hold. It is part of an audit by bounty of delivery v4 (on-chain announcements), which went live on devnet on 2026-10-24.

## Scope

packages/client/src: first-opening.ts, announcement-reads.ts, release-plan.ts, client-settle.ts, client-split.ts, plan.ts, work-records.ts, refutation-standing.ts, reputation.ts; packages/core/src/sealed-delivery-v4.ts

## Invariants

- **DC-1**: firstOpening and openings never return a later announcement while an earlier one opens to the work with the caller's keys, never skip an announcement sealed to a key the caller did not give, and never call a list complete unless every seq is present.
- **DC-2**: A v4 blob opens to the same url and salt for every recipient; a tampered blob, a blob under another worker, or a slot that does not unwrap to the committed key never opens; secrets differ for a different url or recipient set.
- **DC-3**: Reputation and receipts count a refutation only when it is substantiated, take paid records only from settlements the engine emitted, and credit a co-author only as a payee of a split release.
- **DC-4**: The client's settle calls and plans never build a release that pays anyone but the announcing worker (or the signed split recipients), and refuse an opening that does not open to the announcement before sending anything.

## What a high finding is

An invariant break without direct loss: for example a third party blocking a payout until expiry at low cost, a wrong refusal of a valid release, or standing that misstates a worker's record. The judge decides the tier; a finding of a higher tier is paid from that tier's escrow, a lower one from its own.

## Rules for a finding

- It uses only an attacker's powers: any number of its own wallets, any transaction they can sign, any content it serves at its own urls, any announcement or blob it can build. It does not hold the escrow owner's, the attestor's, a committee member's or the admin's keys, and it does not control the RPC node of the party it attacks.
- It reaches its state through transactions the program accepts, never by writing account data.
- These are known and do not pay: a judge paying a later announcer (refutable by design); an owner cancelling after seeing announcements; congestion of a delivery book's write lock; announcement rent being a refundable lockup; refutations whose recipients' keys rotated being listed as unverifiable; loopback spec urls allowed with a loopback RPC url; the client root fetching specs without a DNS check unless given a lookup (the Node entry adds it).
- One finding per escrow; the earliest valid announcement of a delivery is paid.

## Gate

Add one file packages/client/test/hunt/dc-<short-name>.test.ts (vitest, the repository's client package; the test world from `../../src/testing.js` and the existing test helpers may be used). Each failing test's title starts with the invariant id, for example `DC-1 returns a later announcement while ...`. The judge runs node node_modules/vitest/vitest.mjs run test/hunt/(your file) in packages/client three times on the base commit: the same tests must fail every time on an `expect` assertion, not on a thrown setup error. The file must not mock modules of packages/client or packages/core, edit account data, or change any file outside it.

## Deliver

One `git format-patch` file that adds only your test file, made against `main` at the commit the delivery names, with a short report: the invariant, the attack in plain words, why it is reachable with only an attacker's powers, and the money or standing at stake. Announce its sha256 to the judge. A paid finding is fixed in a separate job.
