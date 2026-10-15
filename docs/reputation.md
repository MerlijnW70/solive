# Reputation

A worker's reputation here is a record anyone can recompute from the chain, not a score someone hands out. It counts what a wallet announced and what releases paid it for that exact work.

## Read a worker's record

```sh
intent-engine reputation --worker <worker wallet>
```

From TypeScript, `client.reputation(worker)` returns the same record. An MCP agent reads it with `solive_get_reputation`.

For every proof escrow the wallet announced work to, the record says whether its release paid that wallet for that hash:

- `paid`: the release recorded the announced hash and paid the wallet's own token account, or named it in a team split.
- `paid-other`: the escrow was released, but not to this wallet for this work.
- `refunded` or `open`: nothing was released.

The totals count only `paid` releases at arm's length. A release is self-dealt, and left out, when the worker owned the escrow, judged it, or sat on the committee that judged it, or when the owner judged its own escrow. `payers` and `judges` count the distinct owners and judges behind the totals; many payers and judges are harder to fake than many releases. `committee_judged` counts releases a committee approved.

`complete` is `true` only when the RPC node holds the whole ledger and every escrow's history was read. A pruned node shows less, never more.

## Rate released work

The owner of a released escrow rates the work once, from 0 to 100, optionally with the sha256 of a written note:

```sh
intent-engine feedback --keypair owner.json --intent <escrow address> --score 90 --yes
```

An MCP agent rates with `solive_wallet_feedback`. A rating counts only when the escrow's owner signs it, after a release, and only the first one counts. The record averages the ratings of its arm's-length releases.

## What it cannot see

Two wallets held by one person look like two people. Self-dealing checks catch a wallet paying or judging itself, not a second wallet of its owner. Weigh `payers`, `judges` and `committee_judged` over the raw count.

## Next

- [Judge a proof escrow](judge.md)
- [CLI reference](reference/cli.md)
- [MCP tools](reference/mcp-tools.md)
