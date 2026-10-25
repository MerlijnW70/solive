# Job: Split the oversized test files outside the CLI

The repository keeps TypeScript files under about 500 lines, but these test files grew past it: packages/solver/test/solver.test.ts (1906 lines), packages/client/test/transport.test.ts (1301), packages/core/test/golden.test.ts (869), packages/core/test/e2e.test.ts (852), packages/core/test/builders.test.ts (844), packages/multisig/test/multisig.test.ts (789) and packages/client/test/client.test.ts (522). This job splits them by topic without changing what any test proves.

## Required

1. Every file listed above ends at most 500 lines, split into files named by topic in the same folder; shared helpers move into helper modules rather than being copied.
2. The set of tests is unchanged: every test keeps its exact name, its describe path where that is part of a citation, its body and its assertions. No test is added, removed, skipped or merged.
3. Anything that cites a moved test by file, such as docs/maintainers/threat-model.md and the tests that check those citations, is updated to the new file.
4. A file split never changes test order dependencies: each new file runs alone.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Change only test files in packages/solver, packages/client, packages/core and packages/multisig, and the files that cite them; do not touch packages/cli.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names: `cargo test --workspace`, `bash scripts/ts-test.sh`, `bash scripts/lint.sh` and `bash scripts/pack-test.sh` all pass.
2. The sorted list of full test names (file-independent) reported by vitest for each of the four packages is identical before and after the patch, with the same count; the delivery includes both lists and the command that made them.
3. No TypeScript file in those four packages' test folders is over 500 lines.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
