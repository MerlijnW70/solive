# Job: refuse an escrow that can never pay

A proof escrow whose judge fee leaves less than the rounded-up protocol and partner fees can be created, but no release of it can settle (threat-model row T-80). A worker can do the work and never be paid.

## Build

- `intent-engine create attested`, `solive_wallet_escrow` and `solive_wallet_escrow_plan` refuse, before sending anything, an escrow that no release could settle under the current config, using the same fee math as the release (`packages/core/src/fee.ts` mirrors the program).
- The refusal says why and names the smallest amount, or the largest judge fee, that would settle.
- Every escrow that can settle is created exactly as today.

## Rules

- Read the config once per command or call, as the commands already do; no extra round trip per piece of a plan.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed.
- Regenerate `docs/reference`. Change only `packages/core`, `packages/client`, `packages/cli` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests cover, for the command and both tools: an escrow that cannot settle refused with nothing sent, the boundary case that just settles accepted, and a plan where only one piece cannot settle refused as a whole.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
