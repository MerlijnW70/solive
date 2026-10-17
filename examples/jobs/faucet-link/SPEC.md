# Job: one-click devnet SOL

Devnet refuses most airdrops, so a new wallet starts empty. The faucet form asks the user to paste their address.

## Build

- When the airdrop is refused, `intent-engine setup` and the MCP tool `solive_wallet_setup` give a faucet link with the wallet's address already filled in: the faucet form's `address` field, set with a query parameter on the issue form url.
- The message says in one short sentence: open the link, submit, and run setup again once SOL arrives.
- The link carries only the public address, url-encoded.
- `docs/quickstart.md` says the same in one sentence.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed.
- A test checks that the link names the form, its `address` field and the wallet's address, and that `.github/ISSUE_TEMPLATE/faucet.yml` still has a field with that id.
- Regenerate `docs/reference`. Change only `packages/cli`, `docs` and `.github/ISSUE_TEMPLATE`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. The tests above exist and pass.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
