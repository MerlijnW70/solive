# Job: Find why a resumed live feed counts fewer paid jobs

Two builds of the live feed in `services/live`, reading the same devnet program at the same moment, disagree: a preview whose cached state had not been refreshed for some hours reports fewer paid jobs in the seven-day window than production, which is read often. Both report `stale: false` and a complete history. Find the cause and say whether data is lost for good.

Research only. Change no file, commit nothing, deploy nothing, send nothing on-chain. Devnet reads must be few and spaced.

## How to read both

- Production: `curl -s https://solive-live.vercel.app/api/feed`.
- The preview: from `F:\solive-kit\live-deploy` (linked to the project), find the newest preview url with `vercel ls solive-live`, then `vercel curl <url>/api/feed`.
- The preview's code is `services/live` at `902f563` plus `F:\solive-kit\kill-wave\live-leftovers\delivery.patch`; production runs `services/live` at `main` without that patch.
- A ground-truth count method and saved transactions from an earlier job are in `F:\solive-kit\kill-wave\live-ground-truth\`.

## Questions

1. **Which jobs differ.** Name the paid jobs one feed counts and the other does not, with signatures and times.
2. **The truth.** Decide from devnet which count is right for the window.
3. **The cause.** Explain from the code, with file and line. Check especially: when more new program signatures arrive between two refreshes than one listing page holds (`FEED_SIGNATURE_PAGE`), does the feed list the rest on a later refresh, or does it move its cursor past them and skip them for good? Does the backfill ever cover such a gap? Is the leftovers patch involved at all?
4. **Does it heal.** Would the difference disappear on its own?

## Deliver

The report text: one short answer per question with evidence, a verdict naming which build is right and whether the leftovers patch is involved, and the smallest fix as a description, not a patch. State what you could not verify. Terse.

## Acceptance

1. Every differing job is accounted for with on-chain evidence the judge can check.
2. The judge confirms the cause by reading the cited lines.
3. Nothing was changed, deployed or sent.
