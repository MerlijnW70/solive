# Job: Show users where to see their devnet SOL

A user sent devnet SOL to their own address and thought it never arrived: their wallet app and the explorer showed mainnet. Solive never says that devnet funds show only on devnet, and gives no link that opens the right network.

## Build

1. **An explorer link.** Add an optional `explorer` field to the MCP wallet tools `solive_wallet_setup` and `solive_wallet_balance`: a Solana Explorer url for the wallet's address with `?cluster=devnet` (or the cluster the server uses; none on mainnet, which the wallet refuses anyway). Add the same link to the CLI `setup` output. Additions only: no existing field, text or exit code changes meaning.
2. **One line on wallet apps.** Where the setup result already tells the user what to do next, add at most one short sentence: devnet SOL shows only when the wallet app or explorer is switched to devnet. Keep within the text-size limits the tests enforce in `packages/cli/test/plain-words.test.ts`; do not raise them.
3. **Docs.** One short paragraph in `docs/quickstart.md` (and `docs/mcp.md` if it describes setup) saying how to see devnet funds: the explorer link, or switching the wallet app to devnet. Terse, in the repository's style.

## Tests

The link is present, correct for the address and the cluster, and absent on mainnet; the one-line hint appears and the text-size tests still pass; the docs paragraph is checked like other pinned doc text.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Additions only to tool outputs and CLI output.
- No devnet sends needed.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
