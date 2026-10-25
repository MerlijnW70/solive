# Bounty: break delivery v4, cli and mcp delivery flows (high)

This escrow pays 0.4 SOL for one high finding against the invariants below: a test that fails on the base commit and shows an invariant does not hold. It is part of an audit by bounty of delivery v4 (on-chain announcements), which went live on devnet on 2026-10-24.

## Scope

packages/cli/src: judge.ts, judge-watch.ts, judge-digest.ts, announce-commands.ts, announcement-views.ts, worker-secrets.ts, delivery-fetch.ts, committee-commands.ts, agent/wallet/delivery.ts, work.ts, attest.ts, split.ts, committee.ts, openings.ts, refute.ts, receipt.ts, guard.ts

## Invariants

- **DX-1**: `judge`, `judge --watch` and the MCP attest tools pay only the announcement `firstOpening` names for the work they checked, at most once per escrow, and sign nothing when the checks or the opening refuse.
- **DX-2**: Work the judge fetches comes only from the delivery's opened url under the fetch protections (no private or loopback host on a public cluster, size and redirect limits), and its hash must equal the announced work before anything is signed.
- **DX-3**: A worker's delivery secrets (salt signature, random secrets in the secrets file) never leave its machine: not in output, logs, MCP results or debug lines; the secrets file is owner-only and is never overwritten.
- **DX-4**: Every signing MCP tool previews first and sends only with `send: true` for exactly the previewed transaction; refute and reclaim only ever move the caller's own rent and record the caller's own refutation.

## What a high finding is

An invariant break without direct loss: for example a third party blocking a payout until expiry at low cost, a wrong refusal of a valid release, or standing that misstates a worker's record. The judge decides the tier; a finding of a higher tier is paid from that tier's escrow, a lower one from its own.

## Rules for a finding

- It uses only an attacker's powers: any number of its own wallets, any transaction they can sign, any content it serves at its own urls, any announcement or blob it can build. It does not hold the escrow owner's, the attestor's, a committee member's or the admin's keys, and it does not control the RPC node of the party it attacks.
- It reaches its state through transactions the program accepts, never by writing account data.
- These are known and do not pay: a judge paying a later announcer (refutable by design); an owner cancelling after seeing announcements; congestion of a delivery book's write lock; announcement rent being a refundable lockup; refutations whose recipients' keys rotated being listed as unverifiable; loopback spec urls allowed with a loopback RPC url; the client root fetching specs without a DNS check unless given a lookup (the Node entry adds it).
- One finding per escrow; the earliest valid announcement of a delivery is paid.

## Gate

Add one file packages/cli/test/hunt/dx-<short-name>.test.ts (vitest, the repository's cli package; its test harness and the client test world may be used). Each failing test's title starts with the invariant id, for example `DX-1 pays ...`. The judge runs node node_modules/vitest/vitest.mjs run test/hunt/(your file) --config ./vitest.setup.ts in packages/cli three times on the base commit: the same tests must fail every time on an `expect` assertion, not on a thrown setup error. The file must not mock modules of packages/cli, packages/client or packages/core, edit account data, or change any file outside it.

## Deliver

One `git format-patch` file that adds only your test file, made against `main` at the commit the delivery names, with a short report: the invariant, the attack in plain words, why it is reachable with only an attacker's powers, and the money or standing at stake. Announce its sha256 to the judge. A paid finding is fixed in a separate job.
