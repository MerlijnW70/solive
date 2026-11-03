# Job: Deep audit of the CLI and its MCP tools for open ends, duplicates and untrue text (A2)

Area: `packages/cli`, including `packages/cli/src/agent`, and `packages/multisig`.

This is a read-only audit. Change no code, commit nothing, push nothing, and send no transaction. Find what is unfinished, duplicated, oversized, inconsistent or untrue in your area, and turn it into a ranked list of fix jobs. Report only what you verified in the code, with file and line and evidence.

## What to look for

1. Open ends
   - Options and flags that are parsed but never used, or used but missing from the usage text or `docs/reference`.
   - Error codes defined but never thrown, or thrown but missing from the problems catalog.
   - Exports with no caller outside tests, dead branches, unreachable states.
   - Half-finished features: a CLI path without its MCP equivalent or the reverse. An example of the class: MCP `create` loaded encryption-key openers while CLI `create` did not.
   - Skipped or todo tests, and why they are skipped.
   - Program instructions or account fields the TypeScript side never uses, or client code that assumes fields the program no longer has.
2. Duplicates
   - The same logic written twice where one copy can drift: amount and lamport math, spec hash checks, keypair loading, node and url resolution, retry and backoff, message texts.
   - Tests that test the same thing twice.
3. Size and structure
   - TypeScript files over the repo's file-size limit, with line counts and a natural split for each. Skip program `.rs` files.
   - Circular imports, src importing from test, test code inside shipped src.
4. Truth of text
   - Tool descriptions, next-hints, refusal texts, README and docs claims the code does not guarantee: wrong numbers, wrong defaults, "never" or "only" that some path breaks.
   - Generated references out of date with their source.
5. Safety and money
   - Any path where a previewed figure, fee, refund or payout can differ from what is sent.
   - Fail-open spots: a caught error that becomes success, a missing check on a value from a user or the network, unbounded loops, requests or memory.
6. Repo rules, violations only
   - Comments or prose in src, code not in English, private tool names in tracked files.
   - Hard-coded versions the release bump misses.
7. Operations
   - Workflows that can go red for reasons unrelated to the code, services without limits or monitoring, caps that can be griefed.

## Method

- Read the code before judging it. Cross-check with grep, for example every flag against its use and every error code against the catalog.
- For a duplicate, name both places and show how they can drift.
- For an open end, show that no caller, test or doc closes it.
- Do not report style preferences. Propose no rewrite without a concrete defect.
- Stay inside your area. Note a finding that crosses into another area only where your area's code calls it.

## Report

Write `report.md`:

1. A summary table: area, findings, high, medium, low.
2. Findings, most severe first. Each has an id, file:line, category (open-end, duplicate, split, text, money, safety, rules, ops), what is wrong, evidence, impact and a proposed fix.
3. Fix jobs: group the findings into jobs with disjoint file sets. Give each a one-line goal, its files, the tests that must fail without the fix, and an order: safety and money first, splits last, pure refactors as separate jobs.
4. What you checked and found clean, so a later audit can skip it.

## Acceptance

An independent review checks a sample of findings against the code. A finding that does not hold, or a report that skips part of the area, fails the job.

## Deliver

`report.md`. Announce its sha256 to the judge.
