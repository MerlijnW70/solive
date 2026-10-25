# Bounty: sealed delivery v4 (critical)

This escrow pays 1.0 SOL for one critical finding against the invariants below: a test that fails on the base commit and shows an invariant does not hold. It is part of audit round H14, aimed at the code that changed since rounds H12 and H13: the signing tools, delivery v4 across instructions, reputation, sealed delivery and the judge.

## Scope

packages/core/src: the sealed v4 blob, its recipients and commitments, esk reveal and openWithEsk; packages/client/src: firstOpening, openings, refute and reclaim

## Invariants

- **SC-1**: Only the recipients a sealed blob names (the judge's published key, or the committee members' synced keys) can open its work; a co-author, another worker, or anyone holding the revealed esk of another blob cannot.
- **SC-2**: Revealing an esk to refute exposes only that blob's work, never the work of another blob, slot, announcement or escrow.
- **SC-3**: No two blobs, re-seals or recipient slots share an AES-GCM key and nonce.
- **SC-4**: An opener never accepts as the announced work a blob whose commitment, recipients or content changed after it was announced.

## What a critical finding is

Funds paid to the wrong party, funds lost or locked beyond the escrow's normal refund path, or a release the attestor (or committee quorum) never signed. The judge decides the tier; a finding of a higher tier is paid from that tier's escrow, a lower one from its own.

## Rules for a finding

- It uses only an attacker's powers: any number of its own wallets, any transaction they can sign, any content it serves at its own urls, any announcement or blob it can build. It does not hold the escrow owner's, the attestor's, a committee member's or the admin's keys, and it does not control the RPC node of the party it attacks.
- It reaches its state through transactions the program accepts, never by writing account data.
- These are known and do not pay: anything already listed in docs/maintainers/threat-model.md or the catalog tables in docs/maintainers/ as mitigated, accepted or partial; a judge paying a later announcer (refutable by design); an owner cancelling after seeing announcements; congestion of a delivery book's write lock; announcement rent being a refundable lockup; refutations whose recipients' keys rotated being listed as unverifiable; wallet-slot fingerprints being checked by the client rather than the program; a mint's freeze authority (T-83); delivered code noticing that it is being judged; loopback spec urls allowed with a loopback RPC url; the client root fetching specs without a DNS check unless given a lookup (the Node entry adds it); reputation scans cut off by the history page limit when they report `complete: false`.
- One finding per escrow; the earliest valid announcement of a delivery is paid.

## Gate

Add one file packages/client/test/hunt/sc-<short-name>.test.ts (vitest, the repository's client package; the test world from `../../src/testing.js` and the existing test helpers may be used). Each failing test's title starts with the invariant id, for example `SC-1 returns a later announcement while ...`. The judge runs node node_modules/vitest/vitest.mjs run test/hunt/(your file) in packages/client three times on the base commit: the same tests must fail every time on an `expect` assertion, not on a thrown setup error. The file must not mock modules of packages/client or packages/core, edit account data, or change any file outside it.

## Deliver

One `git format-patch` file that adds only your test file, made against `main` at the commit the delivery names, with a short report: the invariant, the attack in plain words, why it is reachable with only an attacker's powers, and the money or standing at stake. Announce its sha256 to the judge. A paid finding is fixed in a separate job.
