# Job: Move the CLI, the MCP wallet and the solver onto on-chain announcements

On branch `v4-program` deliveries are on-chain announcements (delivery v4). `@intent-engine/client` already announces, lists, opens, settles, refutes, reclaims and reads standing through them (packages/client/src/announce.ts, announcement-reads.ts, announcement-sends.ts, first-opening.ts, release-plan.ts, client-split.ts, work-records.ts, refutation-standing.ts, confirm-release.ts; the calls are described in docs/sdk-client.md). `@intent-engine/cli` (the command line and its MCP wallet server) and `@intent-engine/solver` still use the removed memo flow and do not typecheck. This job moves them onto the client and makes the whole repository pass again.

Read first: docs/sdk-client.md, the client files named above, programs/intent_engine/src/instructions (`announce_delivery`, `refute_release`, `close_announcement`, `close_delivery_book`, the four `fill_attested*`), and in packages/cli: commands.ts, args.ts, job-commands.ts, judge.ts, judge-watch.ts, committee-commands.ts, sealed-commands.ts, reputation-commands.ts, delivery-fetch.ts, agent/registry.ts, agent/wallet/*.ts.

## Rules of the new flow

- A worker delivers by announcing: the sealed url and the commitment to the work's sha256 go on chain in one transaction. There is no separate seal step and no memo.
- A judge finds the work with `firstOpening` and pays that announcement's worker through the settle calls. The payee is always the announcing worker (or, for a split, payees that include it); there is no free choice of payee for a proof escrow.
- Announcements a judge's key cannot open are skipped and shown; refusals (`incomplete`, `key-not-given`, `claim-held`, `nothing-opens`) are shown with what to do next and nothing is signed.
- Reads come from accounts; `--pages`/history options that only served the memo scan go.

## Required

1. CLI, worker side: `deliver` announces through `client.announce` (relayer payer, claims, invite list and committee key sync included) and prints the announcement, seq, commitment and salt; a worker whose signer cannot sign messages (Ledger) gets random secrets that are written to a local secrets file under the CLI's config directory with owner-only permissions, and every later command that needs them (refute) reads that file. `deliveries <intent>` lists the escrow's announcements in seq order with state, the list's completeness and missing seqs. New commands `refute`, `reclaim` and `close-book` wrap the client calls. `record-delivery` and the delivery-sealing forms of `seal`/`unseal` go; spec sealing stays.
2. CLI, judge side: `judge` opens the work with `firstOpening` (the judge's wallet key and published encryption key, as today), runs the spec checks it runs today on the fetched artifact, and settles that announcement; split and committee judging do the same through the client's split and committee settles. `judge --watch` finds new announcements to its attestor from accounts (`announcementsTo`), never from transaction history, and settles each escrow at most once. `committee-vote` and `committee-release` name the announcement they vote on. `receipt` and `reputation` show the standing records, including skipped announcements, roles and refutation standing. Remove options that only fed the memo scan.
3. MCP wallet: the deliver tool announces; the seal-work and record-delivery tools go (sealing happens inside the announcement); the check-delivery tool reports the announcement's seq, state and whether earlier announcements exist; the fetch-work tool returns `firstOpening`'s result including skipped announcements; the attest, attest-split, committee vote and committee release tools settle an announcement; add refute and reclaim tools. Every tool description, next-hint and refusal text follows the repository's rules for agent-facing text (short, true, tested); signing tools keep the preview-then-`send: true` rule.
4. The solver package typechecks and passes its tests.
5. Docs: docs/judge.md, docs/mcp.md, docs/private-jobs.md, docs/reputation.md, docs/first-job.md, docs/maintainers/judge-internals.md, docs/maintainers/threat-model.md and the generated references (docs/reference) describe the announcement flow and no longer mention delivery memos, opening memos or release memos; regenerate generated files with the repository's own scripts rather than editing them by hand. Pinned sentences stay pinned by tests.
6. Delete client code nothing uses any more after this job (for example packages/client/src/unopened.ts if its last user goes); packages/client may change only for such deletions or for a bug you show with a test (report it).
7. Tests for each change.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Do not change the program, the Rust crates or packages/core except to fix a bug you can show with a test (report it). Keep TypeScript files under about 500 lines; split a file you grow past that.
- Keep command and tool names that still exist; list every removed or renamed command, option and tool in the report.

## Acceptance

1. With the patch applied to branch `v4-program` at the commit the delivery names: `cargo test --workspace`, `bash scripts/ts-test.sh` and `bash scripts/lint.sh` all pass.
2. A LiteSVM test drives the CLI: two workers `deliver` to one proof escrow, a griefer announces a blob under the judge's real fingerprint before them that does not open, and `judge` skips the griefer, pays the earliest worker whose announcement opens to the work, and prints the skipped announcement.
3. A LiteSVM test: `judge --watch` picks up an announcement made after it started, settles it once, and does not read transaction history for it (a transport that fails on history reads is fine).
4. A LiteSVM test drives the MCP wallet tools through a full job: deliver, check delivery, fetch work, attest, receipt; and a committee job: deliver to an unsynced committee, member votes, release.
5. A LiteSVM test: a later worker is paid, the earlier worker runs `refute`, the paid worker's `reputation` shows a substantiated refutation; then `reclaim` returns the earlier worker's rent after the window.
6. A test: a worker whose signer cannot sign messages delivers, its secrets file is written with owner-only permissions (skipped on Windows as the repository already does for key files), and `refute` later succeeds from that file alone.
7. No source in packages/cli or packages/solver reads or writes delivery, opening or release memos or scans judge history for deliveries.
8. A test fails when the judge makes `judge` pay an announcement other than the one `firstOpening` returns.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
