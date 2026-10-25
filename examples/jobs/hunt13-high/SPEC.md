# Bounty: a known Solana attack that works against Solive (high)

This escrow pays 0.4 SOL for one high finding made during catalog round H13 (jobs catalog-classes, catalog-incidents, catalog-economics): a known Solana vulnerability class, hack pattern or arithmetic/economic failure that a test shows works against Solive.

## What a high finding is

An invariant break without direct loss, such as a third party blocking a payout until expiry at low cost, or a wrong refusal of a valid action. The judge decides the tier; a finding of a higher tier is paid from that tier's escrow, a lower one from its own.

## Rules for a finding

- It uses only an attacker's powers: its own wallets, any transaction they can sign, content at its own urls, announcements and blobs it builds. It does not hold the escrow owner's, the attestor's, a committee member's or the admin's keys, and it does not control the RPC node of the party it attacks.
- It reaches its state through transactions the program accepts, never by writing account data.
- Behaviour the threat model documents as accepted, and the known items listed in the H12 bounty specs (examples/jobs/hunt12-da-high/SPEC.md), do not pay.
- One finding per escrow; the earliest valid announcement of a delivery is paid.

## Gate

The patch adds exactly one file and changes nothing else: tests/svm/tests/hunt_c_(name).rs for the program (tests named starting with `cat_`), or packages/(package)/test/hunt/c-(name).test.ts for an off-chain package (titles starting with `CAT`). The judge runs that file three times on the base commit (the program built by `bash scripts/sbf.sh` for Rust; the package's vitest, with `--config ./vitest.setup.ts` in packages/cli): the same tests must fail every time on an assertion, not on a setup error. The file must not write account data, mock packages/core, packages/client or packages/cli modules, or mark tests ignored.

## Deliver

One `git format-patch` file that adds only the test file, made against `main` at the commit the delivery names, with a short report: the catalog item, the attack in plain words, why it needs only an attacker's powers, and what is at stake. Announce its sha256 to the judge. A paid finding is fixed in a separate job.
