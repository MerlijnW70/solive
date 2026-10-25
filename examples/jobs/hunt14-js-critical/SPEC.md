# Bounty: the judge sandbox (critical)

This escrow pays 1.0 SOL for one critical finding against the invariants below: a test that fails on the base commit and shows an invariant does not hold. It is part of audit round H14, aimed at the code that changed since rounds H12 and H13: the signing tools, delivery v4 across instructions, reputation, sealed delivery and the judge.

## Scope

packages/cli/src: the judge (judge commands, judge-watch, the viper, node and host engines, the Docker plain-node sandbox, case parsing and verdict signing)

## Invariants

- **JS-1**: A delivery judged against a pinned spec gets the same verdict on every engine the judge runs and on every run; a delivery cannot make one engine pass a case another fails unless the spec itself leaves the answer open.
- **JS-2**: Delivered code cannot read or change anything outside its sandbox: the judge's files and keys, environment variables beyond the documented ones, the network, or the expected answers.
- **JS-3**: A delivery cannot make the judge record or sign a pass for a case it failed, turn a timeout or crash into a pass, or sign a verdict for other work than it ran.

## What a critical finding is

Funds paid to the wrong party, funds lost or locked beyond the escrow's normal refund path, or a release the attestor (or committee quorum) never signed. The judge decides the tier; a finding of a higher tier is paid from that tier's escrow, a lower one from its own.

## Rules for a finding

- It uses only an attacker's powers: any number of its own wallets, any transaction they can sign, any content it serves at its own urls, any announcement or blob it can build. It does not hold the escrow owner's, the attestor's, a committee member's or the admin's keys, and it does not control the RPC node of the party it attacks.
- It reaches its state through transactions the program accepts, never by writing account data.
- These are known and do not pay: anything already listed in docs/maintainers/threat-model.md or the catalog tables in docs/maintainers/ as mitigated, accepted or partial; a judge paying a later announcer (refutable by design); an owner cancelling after seeing announcements; congestion of a delivery book's write lock; announcement rent being a refundable lockup; refutations whose recipients' keys rotated being listed as unverifiable; wallet-slot fingerprints being checked by the client rather than the program; a mint's freeze authority (T-83); delivered code noticing that it is being judged; loopback spec urls allowed with a loopback RPC url; the client root fetching specs without a DNS check unless given a lookup (the Node entry adds it); reputation scans cut off by the history page limit when they report `complete: false`.
- One finding per escrow; the earliest valid announcement of a delivery is paid.

## Gate

Add one file packages/cli/test/hunt/js-<short-name>.test.ts (vitest, the repository's cli package; its test harness and the client test world may be used). Each failing test's title starts with the invariant id, for example `JS-1 pays ...`. The judge runs node node_modules/vitest/vitest.mjs run test/hunt/(your file) --config ./vitest.setup.ts in packages/cli three times on the base commit: the same tests must fail every time on an `expect` assertion, not on a thrown setup error. The file must not mock modules of packages/cli, packages/client or packages/core, edit account data, or change any file outside it.

## Deliver

One `git format-patch` file that adds only your test file, made against `main` at the commit the delivery names, with a short report: the invariant, the attack in plain words, why it is reachable with only an attacker's powers, and the money or standing at stake. Announce its sha256 to the judge. A paid finding is fixed in a separate job.
