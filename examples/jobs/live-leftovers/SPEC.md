# Job: Three small corrections to the live feed

Reviews of the live feed in `services/live` left three known gaps.

## Build

1. **Order within one slot.** After a late read, events of the same slot can appear out of chain order. Keep the order the node listed them in (record a sequence number per listed signature and use it as the tiebreak after slot), or state with evidence why no reliable order exists.
2. **Split release event.** For a split payout, the release event names only the announcing worker. Name every recipient wallet with its share in that event, within the existing event shape (additions only).
3. **Cap boundary.** `KEPT_PAID` keeps the newest paid entries; a split takes several entries and can be cut in half at the boundary, keeping its job count but losing part of its amount. Never cut one job's entries apart: keep or drop a job whole.

## Tests

Each fails if its behaviour breaks: same-slot events keep listing order after a late read; a three-way split's release event names all three wallets and shares; a split at the cap boundary is kept or dropped whole, and the paid amount stays consistent with the kept entries.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines. Public SDK exports only in `services/live`.
- Additions only to the feed's JSON. Old cached state still loads.
- No change outside `services/live`, except its page tests and docs.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
