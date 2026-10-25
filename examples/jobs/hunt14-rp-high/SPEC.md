# Bounty: reputation and standing (high)

This escrow pays 0.4 SOL for one high finding against the invariants below: a test that fails on the base commit and shows an invariant does not hold. It is part of audit round H14, aimed at the code that changed since rounds H12 and H13: the signing tools, delivery v4 across instructions, reputation, sealed delivery and the judge.

## Scope

packages/client/src: reputation, work-records, refutation-standing, release-reads, receipts, standing and the scans they read (announcement-reads, jobs); packages/core/src/account-reads.ts

## Invariants

- **RP-1**: A wallet's paid count, earned and backed amounts count only releases paid at arm's length: a worker cannot raise them with releases it funded, judged or voted on through its own wallets, or by splitting with itself, without the record being marked self-dealt or funded by the worker.
- **RP-2**: A third party cannot remove an honest worker's paid release from its count, or mark it refuted, except through a refutation the program accepted that opens to the paid work.
- **RP-3**: `complete` is true only when every account and transaction the result rests on was read; anything skipped, unreadable or cut off makes `complete` false and is named.
- **RP-4**: A receipt or standing read names the payer, payee, amount and refutations the chain holds for that release, and nothing else.

## What a high finding is

An invariant break without direct loss: for example a third party blocking a payout until expiry at low cost, a wrong refusal of a valid release, or standing that misstates a worker's record. The judge decides the tier; a finding of a higher tier is paid from that tier's escrow, a lower one from its own.

## Rules for a finding

- It uses only an attacker's powers: any number of its own wallets, any transaction they can sign, any content it serves at its own urls, any announcement or blob it can build. It does not hold the escrow owner's, the attestor's, a committee member's or the admin's keys, and it does not control the RPC node of the party it attacks.
- It reaches its state through transactions the program accepts, never by writing account data.
- These are known and do not pay: anything already listed in docs/maintainers/threat-model.md or the catalog tables in docs/maintainers/ as mitigated, accepted or partial; a judge paying a later announcer (refutable by design); an owner cancelling after seeing announcements; congestion of a delivery book's write lock; announcement rent being a refundable lockup; refutations whose recipients' keys rotated being listed as unverifiable; wallet-slot fingerprints being checked by the client rather than the program; a mint's freeze authority (T-83); delivered code noticing that it is being judged; loopback spec urls allowed with a loopback RPC url; the client root fetching specs without a DNS check unless given a lookup (the Node entry adds it); reputation scans cut off by the history page limit when they report `complete: false`.
- One finding per escrow; the earliest valid announcement of a delivery is paid.

## Gate

Add one file packages/client/test/hunt/rp-<short-name>.test.ts (vitest, the repository's client package; the test world from `../../src/testing.js` and the existing test helpers may be used). Each failing test's title starts with the invariant id, for example `RP-1 returns a later announcement while ...`. The judge runs node node_modules/vitest/vitest.mjs run test/hunt/(your file) in packages/client three times on the base commit: the same tests must fail every time on an `expect` assertion, not on a thrown setup error. The file must not mock modules of packages/client or packages/core, edit account data, or change any file outside it.

## Deliver

One `git format-patch` file that adds only your test file, made against `main` at the commit the delivery names, with a short report: the invariant, the attack in plain words, why it is reachable with only an attacker's powers, and the money or standing at stake. Announce its sha256 to the judge. A paid finding is fixed in a separate job.
