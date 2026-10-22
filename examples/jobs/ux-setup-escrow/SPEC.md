# Job: Setup, hiring escrow and balance that explain themselves

A blind hirer and a blind worker finished a full job on devnet with 0.1.44 and reported these rough edges in setup, escrow and balance (`packages/cli/src/wallet.ts`, `packages/cli/src/agent/wallet/account.ts`, `packages/cli/src/agent/wallet/escrow.ts`, `packages/cli/src/agent/wallet/unwrap.ts`, `packages/cli/src/agent/wallet/receipt.ts`).

1. `wallet_setup` says it tops the wallet up below 0.5 SOL. Both wallets held 0.3 SOL, got no top-up, and were told nothing: when devnet refuses the airdrop and the wallet holds enough to start, `next` stays "your wallet is ready; try offering 0.05 SOL for at least 5 TEST".
2. That `next` hint points every new user at a token trade. Users who came to hire or to earn get no pointer to `wallet_escrow` or `find_jobs`.
3. Nothing tells a hirer that it may be the escrow's own attestor (judge), or what a spec should contain for workers to deliver against it.
4. A hiring escrow that sells SOL on devnet records TEST as its output by default, and its preview says "creates your token account for ETU8… (you pay its rent)". The hirer pays rent for an account that is only a label.
5. After `wallet_unwrap` closed the wrapped SOL account, `wallet_balance` still listed it with balance "0".
6. The unwrap preview says the account's rent comes back, but the worker could not reconcile its SOL balance afterwards; no tool output explained the difference.
7. The first `wallet_receipt` with `wait` returned `released: false` and the payment showed up only on a second call.

## Required

- Setup tells the truth about funding: when the airdrop is refused or skipped, `next` says how much the wallet holds and whether that is enough to start, and the tool description matches what setup does.
- Setup's `next` points to the three things a new user comes for: trade, hire (`wallet_escrow`) and earn (`find_jobs`), within the tool text rules.
- `wallet_escrow` says the hirer may name its own wallet as attestor, and in one sentence what a spec must state for a worker to deliver against it.
- Find out whether the program needs the owner's output token account for a proof escrow. If it does not, a proof escrow creates none; if it does, the preview says why in plain words. State the finding in the report with the evidence.
- `wallet_balance` does not list an account that no longer exists, or says it is closed.
- Reproduce items 6 and 7 in tests or explain them in the report. Fix any real defect; where the behavior is right, make the output say what happened (for example the rent returned, or that the release has not landed yet and to call again).
- Add tests for each changed behavior and text.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Only `packages/cli`, plus `packages/core` or `packages/client` only if item 4 needs it, and the generated references and docs the tests check. No program change.
- Keep tool names and inputs as they are. Keep files under about 500 lines.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. The judge reads every changed text, and each tells a first-time user something true and actionable.
3. A test fails when the judge makes setup return the old `next` after a refused airdrop.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
