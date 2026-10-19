# Job: stop a hirer vetoing payment through held cases (T-77)

An adversarial review of sealed held cases (`packages/cli/src/held.ts`, `judge.ts`, `judge-watch.ts`, `flow-commands.ts`, `agent/wallet/escrow.ts`) found that a hirer can take the held file down, serve bad bytes, or pin wrong `expected` values at slot S, so no worker is paid and the hirer is refunded after seeing the work; and that spam queued before S can push an honest delivery past expiry.

## Build

1. **The judge commits to the held file before any work.** When a judge first sees an escrow with `held` (before any announcement is judged), it fetches, unseals and fully checks the held file against its hash, `domain` and checker, keeps its own copy, and refuses the escrow then if anything is wrong; at S it uses its copy, never the url.
2. **Wrong expected values become visible.** After S the judge publishes the held plaintext (for example as a memo chain or a published url recorded in a memo) together with which queued deliveries failed which count of cases, so a hirer whose held cases contradict the published spec can be shown to have done so; record it in the verdict.
3. **Spam cannot exhaust the window.** After S, queued deliveries are judged in parallel up to a bound, with a held-phase timeout per delivery, earliest announcement first; one announcer's later deliveries never delay another announcer's earliest.
4. **The margin check holds everywhere.** The MCP escrow and escrow-plan tools apply the same check as `create attested`; the check refuses (instead of passing) when it cannot read or parse the spec; and the slot-time estimate uses the cluster's recent performance samples rather than a fixed constant.
5. **Smaller:** a malformed `held` block refuses the spec outside viper instead of being ignored; a long correct answer on a checker-checked held case is a spec fault, not a worker fail; a transient fetch failure at the rerun re-queues instead of failing; the docs say a worker may announce again after S and each attempt is one bit.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed.
- Update the T-77 and T-43 rows and the held section of `docs/judge.md`, and regenerate `docs/reference`. Change only `packages` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests show: a held file taken down or changed after the judge first saw the escrow does not stop payment; a held file that fails its checks is refused before any work is judged; the held plaintext is published after S; ten spam deliveries queued before S do not keep an honest earliest delivery from being paid within the margin; the MCP escrow tools refuse a too-short margin and an unreadable spec; and each smaller fix above.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
