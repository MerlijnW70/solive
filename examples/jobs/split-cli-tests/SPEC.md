# Job: Split the CLI's oversized test files

The repository keeps TypeScript files under about 500 lines, but these packages/cli test files grew past it: test/cli.test.ts (2138 lines), test/agent.test.ts (1452), test/judge.test.ts (1410), test/args.test.ts (1027), test/devnet.test.ts (834), test/flows.test.ts (831), test/soak.test.ts (743), test/harness.ts (581) and test/agent-mandate.test.ts (551). This job splits them by topic without changing what any test proves.

## Required

1. Every file listed above ends at most 500 lines, split into files named by topic in the same folder; shared helpers move into helper modules rather than being copied.
2. The set of tests is unchanged: every test keeps its exact name, its describe path where that is part of a citation, its body and its assertions. No test is added, removed, skipped or merged.
3. Anything that cites a moved test by file, such as docs/maintainers/threat-model.md and the tests that check those citations, is updated to the new file.
4. A file split never changes test order dependencies: each new file runs alone.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Change only files under packages/cli/test and the files that cite them.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names: `cargo test --workspace`, `bash scripts/ts-test.sh`, `bash scripts/lint.sh` and `bash scripts/pack-test.sh` all pass.
2. The sorted list of full test names (file-independent) reported by vitest for packages/cli is identical before and after the patch, with the same count; the delivery includes both lists and the command that made them.
3. No TypeScript file under packages/cli/test is over 500 lines.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
