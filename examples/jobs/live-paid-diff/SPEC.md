# Job: Why two builds of the live feed count different paid jobs

The live feed in `services/live` runs in production at https://solive-live.vercel.app/api/feed, built from the code before the move to the public SDK. A preview of the current `main`, built on the published SDK, reads the same devnet program and agrees on events and workers, but reports fewer paid jobs and less SOL paid in the last seven days. Find out which count is right, and why the other differs.

Research only. Change no file, commit nothing, deploy nothing, and send nothing on-chain. Read-only devnet calls only, few and spaced: the public node rate-limits one IP that other services share.

## How to read both

- Production: `curl -s https://solive-live.vercel.app/api/feed`.
- Preview: from `F:\solive-kit\live-deploy` (already linked to the project), find the newest preview url with `vercel ls solive-live`, then read it with `vercel curl <url>/api/feed`.
- The production code is `services/live` at commit `0b56f59`; the preview code is `services/live` at the current `main`.

## Questions

1. **The difference.** List the paid jobs each build counts in its seven-day window (escrow or intent, release signature, amount, time), and which jobs are in one list and not the other.
2. **The truth.** For each differing job, read devnet and decide whether it was really paid within the window, and for how much. Cite the signatures.
3. **The cause.** Explain from the code why the wrong build counts what it counts: for example a window or cut-off difference, a transaction given up after the retry cap, an empty cache that never backfilled older activity, a change in how releases or splits are read, or double counting. Cite file and line in both versions.
4. **Does it heal.** Would the difference disappear on its own as the preview keeps running, or is it permanent?

## Deliver

`report.md`: one short answer per question with evidence (commands and output, signatures, file and line), a verdict naming which build is right, and, if the current code is wrong, the smallest fix as a description, not a patch. State what you could not verify. Keep it terse.

## Acceptance

1. Every differing job is accounted for with on-chain evidence the judge can check.
2. The judge confirms the cause by reading the cited lines.
3. Nothing was changed, deployed or sent.

## Deliver

Return the report text; the judge saves it and announces its sha256.
