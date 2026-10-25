# Job: Public client scans skip an unreadable account and name it

Since `account-version-reads`, every engine account the packages read goes through the core decode functions in packages/core/src/account-reads.ts, and the CLI and solver scans skip an account of an unknown layout and name it with the reason. The public scans of `@intent-engine/client` still fail as a whole: `client.intents()`, `client.jobs()`, `client.announcements()`, `client.announcementsTo()`, `client.announcementsBy()` and the refutation reads behind `client.reputation()` throw `AccountVersionError` or `NotAnEngineAccount` when one account among many cannot be read. After the next layout change, one old or newer account would break every app that lists jobs. Only `client.watch()` already reports such an account, through `IntentUnreadable`.

## Required

1. The client exports `UnreadableAccount` (`{ address, reason }`, the type core already has) from its public root.
2. `client.intents()` returns `{ intents, unreadable }` and `client.jobs()` returns `{ jobs, unreadable }`. `client.announcementsTo()` and `client.announcementsBy()` return `{ announcements, unreadable }`. Each skips only an account of an unknown layout or kind, using core's `readAccounts`, and lists it in `unreadable`; every other error still fails the call.
3. `client.announcements()` (the `AnnouncementList`) gains `unreadable`. An announcement of this escrow that cannot be read makes `complete` false, since the list can no longer prove every sequence number is present.
4. `client.reputation()` and every receipt or standing read that counts refutations or announcements gain `unreadable`. A refutation or announcement that cannot be read is never counted as clean: the result says it is incomplete in the field it already uses for that, or gains one if it has none.
5. Every caller in packages/client, solver, cli and multisig, the examples and the guides moves to the new shapes, the API reports are regenerated with the repository's own script, and the generated references too if they change. CLI and MCP output that lists jobs or intents names the skipped accounts the way the CLI scans already do.
6. Tests for each change, including at least: `client.intents()` and `client.jobs()` returning the valid accounts beside a newer-layout intent and naming it; `client.announcements()` reporting `complete: false` with an unreadable announcement of the escrow; `client.reputation()` not counting an unreadable refutation as clean.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Do not change the program, the IDL or the generated client. Keep TypeScript files under about 500 lines. Breaking the shapes above is intended; keep every other public name and shape as it is.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names: `cargo test --workspace`, `bash scripts/ts-test.sh`, `bash scripts/lint.sh` and `bash scripts/pack-test.sh` all pass.
2. The tests in Required 6 pass.
3. A test fails when the judge makes `client.jobs()` drop the unreadable list.
4. A test fails when the judge makes `client.announcements()` report `complete` without regard to unreadable announcements.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
