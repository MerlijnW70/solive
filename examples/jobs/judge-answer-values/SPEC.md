# Job: Drawn answers reach the checker only as values every engine agrees on

The fix for audit round H14 (commit a67b995) made the judge fail a drawn case whose delivery returns `undefined` and refuse specs whose strings UTF-8 cannot carry. Its worker found two cases it left open, both in packages/cli/src (draw.ts, viper.ts):

- A drawn answer of `NaN`, `Infinity` or `-Infinity` reaches the draw checker as a number from ViperJS, while published cases only accept finite JSON numbers (the `fits` rule in draw.ts and viper.ts).
- A drawn answer that is a string holding a lone surrogate reaches the checker changed, because ViperJS's output is UTF-8 and turns the surrogate into U+FFFD, while the host engine would see the exact string.

In both cases the checker judges a value the delivery did not return, or one the judge's published-case rules would never accept.

## Required

1. A drawn answer that is not a value the published-case rules accept (a non-finite number, a string holding a lone surrogate, or anything else `fits` rejects) fails that drawn case with a reason that names it; it is never handed to the checker. This holds whichever engine produced the answer.
2. Where the engine cannot report the answer exactly (ViperJS's UTF-8 output), the judge detects that the answer may have been changed and fails the case rather than judging a changed value; docs/maintainers/judge-internals.md says how.
3. docs/judge.md states which answers a drawn case accepts.
4. Tests for each change, including `NaN`, `Infinity`, `-Infinity` and a lone-surrogate string returned on a drawn case, and a control that an ordinary finite number and an ordinary string still reach the checker.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Change only the judge in packages/cli/src, its tests and the two judge docs. Do not change the pinned ViperJS wasm. Keep TypeScript files under about 500 lines.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names: `cargo test --workspace`, `bash scripts/ts-test.sh`, `bash scripts/lint.sh` and `bash scripts/pack-test.sh` all pass.
2. A test fails when the judge lets a `NaN` drawn answer reach the checker.
3. A test fails when the judge lets a drawn answer that ViperJS could not report exactly reach the checker.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
