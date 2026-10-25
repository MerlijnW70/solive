# Job: Catalog round: every known Solana hack pattern against Solive

Real Solana incidents are collected by Helius (https://helius.dev/blog/solana-hacks), grouped as application exploits, supply chain attacks, core protocol vulnerabilities and network attacks, and summarised by CertiK for 2022 (https://www.certik.com/blog/2022-solana-exploits-overview). This job maps every incident pattern there to Solive (program, client, CLI, MCP wallet, solver, release pipeline) and proves Solive resists each one that can apply.

Read first: docs/maintainers/threat-model.md (rows already covered, and how it cites tests), the program in programs/intent_engine and crates/intent-core, the existing tests in tests/svm/tests and the packages' test folders, and the sources above (fetch them).

## Required

1. docs/maintainers/catalog-incidents.md: one table with a row per incident (for example Wormhole's spoofed signature verification, Cashio's unchecked account chain, Crema's fake tick account, Mango's price manipulation, Nirvana's flash-loan economics, Slope's leaked keys, the npm supply chain attacks), each with: the source link, the pattern in one sentence, where it would hit Solive, applies or not (with the reason), and the test or check that proves resistance.
2. A passing test for every applicable row: LiteSVM tests in new files tests/svm/tests/catalog_incident_*.rs for program patterns, vitest tests in a new test/catalog folder of the right package for off-chain patterns (key handling, logging, dependency pinning, RPC trust); existing tests or CI checks may be cited when they prove exactly the row.
3. A test fails when a test or check the table cites does not exist.
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
