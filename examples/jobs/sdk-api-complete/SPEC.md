# Job: A client API apps can build on

`createClient` in packages/client sends every write itself: only `prepareAnnouncement` and `prepareCommitteeRelease` return instructions without sending. An app that signs through a wallet adapter, a multisig or a bundle service cannot use the other writes. The client also names an intent two ways (an address in most calls, owner and nonce in `intent`, `cancel`, `expire` and `close`), cannot create an intent with a partner, a partner fee or a separate payee although the CLI can (`create --partner --partner-bps --pay-to`), has no helper between decimal text and base units, filters `intents()` only by owner and status, and caps `history` without paging. This job fills those gaps.

Read first: packages/client/src/client.ts, client-types.ts, client-intents.ts, client-reads.ts, client-settle.ts, client-split.ts, client-committee.ts, client-claims.ts, announcement-sends.ts, release-plan.ts, simple-tokens.ts, transport.ts, rpc-transport.ts, svm.ts, the CLI's create command (packages/cli/src/order-builders.ts, command-builders.ts), and docs/sdk-client.md.

## Required

1. Instructions layer: `client.plan` has one method per client write (create intent, cancel, fill, expire, close, settle proof, settle committee, settle split, announce, refute, reclaim, close book, feedback, create committee, unwrap). Each returns the instructions in order, any setup instructions that must land first, the address that pays, the signers each instruction needs, and the lookup tables it relies on, and sends nothing. Every existing write is `plan` followed by sending, so the two cannot drift; `prepareAnnouncement` and `prepareCommitteeRelease` become thin names for their `plan` methods or are removed (report which).
2. `IntentRef` is an intent address or `{ owner, nonce }`. Every client call that names one intent takes an `IntentRef`; the old positional forms are replaced, and the report lists each changed signature.
3. `createIntent` and its plan take `partner` with `partnerBps`, and a payee (`payTo`) where the engine supports one, with the CLI's rules and refusals; the CLI's create builds through the client for these options instead of its own code where that removes a duplicate.
4. `client.amount(mint, text)` turns decimal text into base units using the mint's decimals, refusing too many decimals, negatives and non-numbers with `InvalidInput`; `client.format(mint, amount)` does the reverse. Both read decimals once per mint and agree with the simple layer's parsing.
5. `intents(filter)` filters on the node with account filters for owner, status, kind, input mint, output mint and attestor, combined, on both the RPC and svm transports, and returns only matching accounts.
6. `history(intent, { limit, before })` returns events and a cursor for the next older page; paging through all pages returns every event once, in order.
7. docs/sdk-client.md documents the plan layer with one runnable example that plans a proof escrow, signs and sends it through `client.send`-free kit calls, and reads it back; every new sentence is pinned by a test as the page's other sentences are.
8. Tests for each change, on the test world from `@intent-engine/client/testing`.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Do not change the program or the Rust crates. Keep TypeScript files under about 500 lines.
- packages/cli, packages/solver and the simple layer keep compiling and passing; adapt them to the new signatures.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names: `cargo test --workspace`, `bash scripts/ts-test.sh`, `bash scripts/lint.sh` and `bash scripts/pack-test.sh` all pass.
2. For every client write, a test sends its `plan` output itself and shows the same on-chain result as the write; a test fails when a write and its plan diverge.
3. A test creates an intent with a partner and partner fee, fills it, and shows the partner paid its share.
4. A test pages `history` through more than one page and gets every event exactly once.
5. A test shows `intents` with kind and attestor filters returns only matching accounts, and that the filter runs on the node (the transport receives the account filters).

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
