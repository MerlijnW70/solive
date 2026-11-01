# Job: A new user never gets stuck at zero SOL

An outside user installed the MCP server, and their new wallet held 0 SOL: the instant faucet had run dry, nothing said so clearly, and nothing told them they could fund the wallet from their own wallet app switched to devnet. The owner had to send devnet SOL to their app wallet so they could forward it. The instant faucet's wallet was not watched by the monitor, so nobody noticed it was empty.

## Build

1. **Watch the instant faucet.** The monitor (`monitoring/devnet.json`, the `monitor` command and its workflow) alerts when the instant faucet's wallet (the one `services/faucet` pays from) falls below enough for a day of drips, the same way it watches the filler and the issue faucet. State the threshold and why.
2. **Say why, and what next.** When `setup` or `solive_wallet_setup` ends with too little SOL, its result says plainly why (the instant faucet is out of SOL, devnet refused the airdrop, or the rate limit applies) and lists the ways to get SOL in order of how fast they are, including sending devnet SOL from any wallet app switched to devnet to the address it names. Keep within the text-size limits the tests enforce in `packages/cli/test/plain-words.test.ts`; do not raise them.
3. **Docs.** `docs/quickstart.md` and `docs/mcp.md` say in a few lines what to do when the wallet holds 0 SOL, matching the tool text. Terse.

## Tests

Each fails if its behaviour breaks: the monitor alerts below the threshold and not above; each refusal reason maps to its plain text; the funding list includes the wallet-app route with the address; text-size tests still pass; docs text is checked like other pinned docs.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Additions only to tool outputs; no exit code changes meaning.
- No devnet sends needed.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
