# Job: Never skip signatures when a burst outruns one listing page

The live feed in `services/live` lists new program signatures with `until` set to its cursor and a page limit (`FEED_SIGNATURE_PAGE`), then moves the cursor to the newest one (`src/feed.ts`, around the `reader.newSignatures` call). When more signatures arrive between two refreshes than one page holds, the older ones are never listed: a research job found a resumed feed that missed 13 paid jobs this way, while the chain and a often-read feed had them. The backfill does not cover the gap, because it only walks older than the oldest signature read and closes once the window is reached. Production is exposed whenever it is not read for a while.

## Build

1. **Fill the gap.** When a new-signatures page comes back full and does not reach the cursor, keep listing older pages with `before` set to the oldest returned and `until` set to the cursor, until a page is short or reaches the cursor. Queue every signature found. Only then advance the cursor.
2. **Bounded and resumable.** The walk shares each refresh's call budget and deadline with everything else, stops at the seven-day window edge, and keeps its place in state so the next refresh continues it instead of starting over or skipping. New activity is still read first.
3. **Honest while catching up.** While a gap walk is unfinished, the feed's `history` says it is not complete, so the page shows the figures as still filling.
4. **Saved state.** State saved by the current version still loads. Additions only to the feed's JSON.

## Tests

Each fails if its behaviour breaks: a burst of more than one page between two refreshes ends with every signature read and every paid job counted; the walk resumes across refreshes and a cold instance; it stops at the window edge; the call budget per refresh is unchanged; `history.complete` is false until the walk ends; a refresh with fewer new signatures than a page behaves as today.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines. Public SDK exports only in `services/live`.
- No change outside `services/live`, except its page tests and docs.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested.
3. A preview whose state was not read for a while, then read after a burst, reports the same paid jobs as the chain.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
