# Job: Backfill the live feed's history on an empty cache

The live feed in `services/live` keeps its state in a cache. On an empty cache it reads only the newest page of program signatures and from then on only newer ones, so activity older than that page never counts. A preview started from an empty cache reported fewer paid jobs in the last seven days than production, whose cache was older, and the gap lasts until those jobs leave the window. A seven-day figure must not depend on how old the cache is.

## Build

1. **Backfill.** When the state has no history yet, or its oldest read signature is newer than the start of the seven-day window, page backwards through the program's signatures with `before` until a signature is older than `PAID_WINDOW_SECS`, and queue those transactions to be read like new ones. Keep the place reached in the state, so the backfill resumes on the next refresh instead of starting over.
2. **Within the budget.** The backfill shares each refresh's existing call budget and deadline with new activity. New activity comes first. The 429 handling, `retry_at`, the unread retry cap and the refresh deadline all keep working as today.
3. **Honest while filling.** While the backfill has not reached the window start, the feed says so in its JSON (for example a field naming how far back the history reaches), and the page shows the seven-day figures as still filling instead of as final. Pick the smallest clear way and document it in `services/live/README.md`.
4. **Old saved state.** State saved by the current version still loads; it starts a backfill only if its history is shorter than the window.

## Tests

Each fails if its behaviour breaks: an empty cache over a node with activity older than one page ends, after enough refreshes, with every paid job of the window counted and nothing older; the backfill resumes where it stopped; new activity is read before backfill in the same refresh; the call budget per refresh is unchanged; a 429 mid-backfill keeps what was read and sets `retry_at`; the JSON marks the history as filling and then as complete; old saved state loads.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines. Public SDK exports only in `services/live`.
- No change outside `services/live`, except docs that describe it.
- Read-only devnet, few and spaced, if you try it live.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested.
3. A preview built from the patch, started from an empty cache, reports the same seven-day paid count as production once its history is complete.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
