# Job: the program refuses an escrow no release can settle (T-80)

The command line and the MCP tools refuse a proof escrow whose judge fee leaves less than the rounded-up protocol and partner fees (`releaseSettles` in `packages/core/src/fee.ts`), but the program still accepts one made another way, so a worker can do the work and never be paid (threat-model row T-80). Solive has no users yet, so the account layout and instructions may change.

## Build

- `create_intent` and every other path that creates a proof escrow (signed, by agent, committee) refuse, with a new named error, an `AttestedResult` escrow for which no release could settle under the current config: amount not above the judge fee, or the rest too small for the rounded-up protocol and partner fees. The check is the same fee math the release uses (`crates/intent-core/src/fee.rs`).
- A config change that would make existing escrows unsettleable is out of scope; say in the T-80 row what remains.
- The TypeScript `releaseSettles` and the program agree on every input: a property test in `crates/intent-core` and the TS core test compare them on the same generated cases, or the TS check is generated from the same table.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed. Rust tests live outside `src`.
- Regenerate the IDL and the TS bindings with the repository's scripts. Update the T-80 row (status and evidence) in `docs/maintainers/threat-model.md` and `docs/reference`.
- Change only `programs`, `crates`, `tests/svm`, `packages` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. LiteSVM tests show each creation path refusing the boundary case that cannot settle with the new error and accepting the one that just settles; the property test shows Rust and TS agree.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
