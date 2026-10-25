# Job: Find and claim held split shares from the SDK, the CLI and the MCP server

Commit 6d29340 changed the program: when a split release cannot pay a co-author because its canonical token account cannot accept the transfer (required memos, frozen, or another extension that blocks it), the release still pays everyone else and holds that co-author's share in the escrow's vault. The paid announcement's `held` byte marks the held indexes, the intent's `held` byte marks an escrow that holds a share, and the release emits a `ShareHeld` event per held share (wallet, account, index, share). The co-author takes the share with the new `claim_held` instruction (index plus the split's recipients and weights, as the release named them) into any token account it owns. `close_intent` refuses with `SharesHeld` until every share is claimed or a year after the escrow expires; `close_announcement` refuses while its escrow holds a share. A protocol fee whose account cannot accept it is now withheld with role 5 like the judge and partner fees. The generated client in packages/core already has the instruction, the events and the errors.

## Required

1. Core gets a builder for `claim_held` beside the other release builders, taking the escrow, the paid announcement, the wallet, the receiving account, the index and the split, with the mint cap when the escrow is capped.
2. The client can list the shares held for a wallet (from the `ShareHeld` events and the announcements' `held` bytes, so a claimed share is no longer listed) with escrow, announcement, index, amount and the split needed to claim it, and can claim one: `client.heldShares(wallet)` and `client.claimHeld(...)`, with a plan variant like the other sends. Reading the split must not trust a source an attacker controls; take it from the release transaction the program executed.
3. Receipts, reputation records and the work records count a held share as paid to its co-author's wallet but not yet received, and name it; a claimed share reads as received. A withheld protocol fee is reported like the other withheld fees.
4. The CLI gets a `claim-held` command, and the MCP wallet server a `wallet_claim_held` tool with the preview-and-approval binding the other wallet sends use; `wallet_history`, `find_jobs`-style listings and the reclaim output name held shares where they matter, and `close` tools explain `SharesHeld`. Tool descriptions and next-hints stay short and accurate; generated references are regenerated.
5. docs/sdk-client.md, docs/judge.md (or the guide that explains splits) and the CLI docs say what a held share is and how to claim it.
6. Tests for each change, using the test world, including a split release with one co-author's account requiring memos, listing the held share, claiming it into another account, the listing becoming empty, and the MCP tool refusing a send whose terms differ from its preview.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Do not change the program, the IDL or the generated client. Keep TypeScript files under about 500 lines.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names: `cargo test --workspace`, `bash scripts/ts-test.sh`, `bash scripts/lint.sh` and `bash scripts/pack-test.sh` all pass.
2. The tests in Required 6 pass.
3. A test fails when the judge makes `client.heldShares` list a share that was already claimed.
4. A test fails when the judge makes the MCP claim send without checking its approval.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
