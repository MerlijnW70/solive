# Job: Fix what a new user walk found on money text and refusals (N4)

A walk of `@intent-engine/cli@0.1.80` as a new user found these. Its report is in `F:\solive-kit\kill-wave\fresh-hirer-walk\report.md`, with exact outputs in `walk.log` beside it. Reproduce each one first.

## Build

1. **Cancel overstates money.** `solive_wallet_cancel` of a SOL escrow with `close` says 14595800 lamports of "rent and bounty" where the transaction returns 4595800, as a wrapped SOL vault's lamports include the escrowed amount, which the same summary also lists (`packages/cli/src/agent/settle.ts`). Make the figure true for every token, and check other previews that sum account lamports the same way.
2. **CLI escrow with a wrong hash.** `create attested` sends an escrow whose `spec_url` hashes to something else with no warning, while the MCP tool warns (`specPreflight`, `packages/cli/src/agent/wallet/escrow.ts`). Give the CLI path the same check and warning.
3. **No reader warning.** A preview for an escrow with `publish_spec` off and no url, or a sealed spec with no url, warns that no reader can get the spec.
4. **Zero hash.** An all-zero `spec_hash` is refused with "needs an attested order with spec_hash". Say what is really wrong (`packages/cli/src/agent/create.ts`, `packages/cli/src/agent/signed-terms.ts`).
5. **Fresh home.** Read commands with no node set go to `127.0.0.1:8899` and blame the network. When nothing chose that url, say that no node is set and to run setup or pass `--url devnet`. A `missing --keypair` in a home with no wallet says to run setup. Keep the localhost default: only the words change.
6. **Faucet refusal.** `setup` prints the faucet's reason with the words "wait retry_after seconds" and no value, and `why` names a per-address limit for a limit on the whole faucet. Show the real wait, and a `why` that matches (`packages/cli/src/faucet.ts`, `packages/cli/src/wallet.ts`). Keep working with the faucet as deployed: do not change `services/faucet`.
7. **Words.** The receipt mentions a `valid` field that is absent, and `standing_complete` has no explanation (`packages/cli/src/agent/wallet/receipt.ts`, `packages/cli/src/agent/wallet/standing.ts`). `NoSpecUrl` says other sources were tried when they were (`packages/cli/src/agent/spec.ts`). `help` of an unknown command says so and exits non-zero. The CLI escrow preview shows the cost as the MCP preview does.

## Tests

Each item has a test that fails if its behaviour breaks, with the exact figures for item 1 from a local program test on wrapped SOL and on another token. Texts stay within the limits in `plain-words.test.ts` and the docs lint.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- No program change. Additions only to public exports and tool outputs, apart from the wording above. Update the generated tool reference and the API report if they change.
- Do not touch `packages/cli/src/job-pages.ts`, `packages/cli/src/agent/jobs.ts`, `packages/client/src/job-specs.ts` or `packages/client/src/rpc-transport.ts`; other jobs are changing them.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
