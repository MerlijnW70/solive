# Job: large proof escrows need a committee (T-66)

A proof escrow names a committee only if its owner chooses one, so a large escrow can rest on one judge who may be bribed or mistaken (threat-model row T-66). Solive has no users yet, so the config layout may change.

## Build

- The config gains a committee floor per mint, set through the existing admin and multisig path (`update-config` or a new admin command, whichever fits the existing pattern); zero means no floor.
- `create_intent` and every other proof-escrow creation path refuse, with a new named error, an attested escrow whose escrowed amount is at or above its mint's floor unless its attestor is a committee with a threshold of at least two.
- The CLI, the MCP escrow tools and `show config` show the floor, and the escrow tools say before sending when a committee is needed.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed. Rust tests live outside `src`.
- Regenerate the IDL and the TS bindings with the repository's scripts. Update the T-66 row, `docs/judge.md` (committees) in at most three sentences, and regenerate `docs/reference`.
- Change only `programs`, `crates`, `tests/svm`, `packages` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. LiteSVM tests show: an escrow just below the floor with a single judge is created; one at the floor with a single judge is refused; one at the floor with a 2-of-n committee is created; a 1-of-n committee does not count; a floor of zero imposes none; and each creation path enforces it.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
