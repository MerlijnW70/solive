# Job: Do not call a quiet service down on the live page

The live page in `services/live` shows a light per service. For the demo worker and the filler it says "Down" when their wallet has sent no transaction within the service window (`src/services.ts`, `walletState`). The filler only sends when there is a swap to fill, so on a quiet devnet it reads "Down" while the service runs fine. That tells visitors something false.

## Build

1. **Quiet, not down.** For services judged only by wallet activity, report `quiet` instead of `down` when the wallet has activity but none in the window, and keep `down` only for what really is down (for the faucet: below one drip; a wallet that never acted: say `unknown`, not `down`). Add the time of the last activity to the feed, so the page can say "Quiet, last active 3 h ago".
2. **Page.** Show the new state with its own word and style, and the last-activity time. Keep "Up", "Down" and "Unknown" as they are.
3. **Compatibility.** A feed answer without the new fields still renders as today. Old cached state still loads.

## Tests

Each fails if its behaviour breaks: activity inside the window is `up`; activity only before the window is `quiet` with its time; no activity ever is `unknown`; the faucet below one drip is `down`; the page renders `quiet` with the time, and renders an older feed answer as today.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines. Public SDK exports only in `services/live`.
- No change outside `services/live`, except its page tests in `packages/cli/test/live-site` and docs that describe it.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A preview shows the filler as quiet with its last activity, not down.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
