# Job: fees fixed when an intent is created (T-80)

A release charges the protocol fee and partner cut the config holds at release time, so an admin change can leave an open proof escrow that can no longer settle, and changes what every open order pays (threat-model row T-80, `programs/intent_engine/src/policy.rs` `FeeSchedule`). Solive has no users yet, so the intent layout may change without a version flag.

## Build

- Every intent records, when it is created, the fee terms that apply to it: its kind's protocol fee in basis points and the partner cut in basis points (and anything else `FeeSchedule::terms` reads from the config).
- Every fill and release of that intent uses the recorded terms, never the current config. A config change applies only to intents created after it.
- The create-time settle check (`ReleaseCannotSettle`) uses the same recorded terms, so an escrow accepted at create can always settle.
- The SDK, CLI and MCP previews (`describe`, fee lines, `net_pay`, `releaseSettles`) read the recorded terms from the intent when it exists.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed. Rust tests live outside `src`.
- Regenerate the IDL and the TS bindings with the repository's scripts. Update the T-80 row (status and evidence), and any fee wording in `docs` that says fees come from the current config, and regenerate `docs/reference`.
- Change only `programs`, `crates`, `tests/svm`, `packages` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. LiteSVM tests show: an escrow created before an admin raises the fee or partner cut still releases with the old terms and conserves every unit; an intent created after the change pays the new terms; a swap or limit fill after the change uses its own recorded terms; and the escrow that just settled at create still settles after any config change.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
