# Job: remove clear delivery announcements

Delivery announcements now come in two forms: v1 memos that carry the work's sha256 and url in clear, and v2 memos that bind the hash to the announcing wallet and seal the url to the judge (`packages/core/src/sealed-delivery.ts`). A v1 announcement can still be copied by anyone who reads it (threat-model row T-38). Solive has no users yet, so nothing needs to read or send v1 any more.

## Build

- Remove the v1 delivery memo everywhere: building, parsing, scanning, matching, the `version` options and flags, and the code paths and tests that exist only for it. Every reader (judge, watch, release tools, receipts, reputation, trust, check-delivery, smoke run) works from v2 announcements only.
- Keep the public names that v2 still uses; rename anything whose name only made sense next to v1.
- Update the T-38 row's evidence and gap in `docs/maintainers/threat-model.md`, the delivery sections of `docs/judge.md` and `docs/sdk-client.md`, and regenerate `docs/reference`.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed.
- Change only `packages` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A search of `packages` finds no code that builds or parses the v1 delivery memo, and a test shows a v1-shaped memo is ignored by the judge's scan.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
