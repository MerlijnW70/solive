# Job: Catalog round: every known Solana vulnerability class against every instruction

The Solana vulnerability classes are catalogued in Coral's sealevel-attacks repository (https://github.com/coral-xyz/sealevel-attacks), which Solana's program security course follows (https://solana.com/developers/courses/program-security/security-intro), with the guide at https://helius.dev/blog/a-hitchhikers-guide-to-solana-program-security. This job maps every class there to every instruction of programs/intent_engine where it can apply, and proves the program resists each one.

Read first: docs/maintainers/threat-model.md (rows already covered, and how it cites tests), the program in programs/intent_engine and crates/intent-core, the existing tests in tests/svm/tests and the packages' test folders, and the sources above (fetch them).

## Required

1. docs/maintainers/catalog-classes.md: one table with a row per class and instruction pair that can apply (signer authorization, account data matching, owner checks, type cosplay, initialization and reinitialization, arbitrary CPI, duplicate mutable accounts, bump canonicalization, PDA sharing, closing accounts and revival, sysvar address checks, and every further class the sources list), each with: the source link, applies or not (with the reason), and the test that proves resistance.
2. A passing LiteSVM test for every applicable row, in new files tests/svm/tests/catalog_*.rs, each test named after its class and instruction; existing tests may be cited instead when they prove exactly the row.
3. A test (Rust or TypeScript, wherever the repository already checks docs citations) fails when a test the table cites does not exist.
4. The table is complete: every class, incident or checklist item in the sources has its rows. Rows already proven by a threat-model row may cite that row's evidence.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, English, at most 500 lines per TypeScript file. Change no program, crate or package source: this job adds evidence, not fixes.
- Tests that show the program or tool resists an attack go in as normal, passing tests (Rust in tests/svm/tests, TypeScript in the package's test folder). An attack that succeeds is a finding: do not fix it; put its failing test in a separate one-file patch and report it to the judge, who pays it from the H13 bounty escrows (critical 1.0, high 0.4, medium 0.1 SOL) under the H12 bounty rules (attacker's powers only, reachable state, no account-data writes).
- A row may say "does not apply" only with the concrete reason in our code (file and mechanism), never a general claim.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names: `cargo test --workspace`, `bash scripts/ts-test.sh`, `bash scripts/lint.sh` and `bash scripts/pack-test.sh` all pass.
2. Every test the table cites exists and passes; the citation test fails when the judge renames one.
3. The judge samples rows and finds each applicable row's test actually exercises the attack it names (it fails when the judge removes the defence it relies on, where that can be done in a test build).

## Deliver

One `git format-patch` file with the table and the passing tests, made against `main` at the commit the delivery names, and separately one patch per finding. Announce each sha256 to the judge.
