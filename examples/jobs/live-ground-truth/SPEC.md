# Job: Count the program's paid jobs of the last seven days from the chain

A new build of the live feed in `services/live` backfills a full seven days of history. It reports far more paid jobs, paid SOL and distinct workers in that window than the production build, whose cache began later. Before the new build replaces production, establish the true figures independently from devnet.

Research only. Change no file, commit nothing, deploy nothing, send nothing on-chain. Devnet reads must be spaced; the public node rate-limits one IP that other services share, so prefer one paced pass with retries on 429.

## What to count

The program is `GHFB9q4fhhqRyCoycoivdxMhFkp1aLHJk5VvroUsgrJU` on devnet. The window is the seven days before the moment you start; state it.

1. **Paid jobs.** Every successful transaction in the window that paid a worker out of a job escrow: a release of an attested escrow to a payee, including split payouts (one job even when it pays several wallets). Do not count swap fills of ordinary orders, cancels, refunds or claims. Say exactly how you tell a paid job from a swap fill, citing the program's instruction or event names in `programs/intent_engine/src` or the decoder in `packages/core/src`.
2. **Paid amount.** The total paid to payees per token, net of the protocol fee.
3. **Distinct workers.** The distinct payee wallets of those paid jobs.
4. **Breakdown.** Count per instruction kind, and how many paid jobs went to wallets that also own or judge the escrow.

## Compare

Read the new build's feed: from `F:\solive-kit\live-deploy` (linked to the project), find the newest preview url with `vercel ls solive-live` and read `vercel curl <url>/api/feed`; its `stats` and `history` fields hold its figures. Read production with `curl -s https://solive-live.vercel.app/api/feed`. For each figure, say whether the new build matches the chain, and if not, which transactions it counts wrongly and why, citing `services/live/src` file and line at the current `main` plus the backfill patch at `F:\solive-kit\kill-wave\live-backfill\delivery2.patch`.

## Deliver

The report text: the window, your method, the four counts with evidence (signature lists or a reproducible script and its output), the comparison with both builds, a verdict on whether the new build's figures are right, and what you could not verify. Terse.

## Acceptance

1. The judge reruns your method on a sample and gets the same classification.
2. Every difference with the new build is explained with cited transactions or lines.
3. Nothing was changed, deployed or sent.
