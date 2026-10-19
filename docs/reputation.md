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
- `unknown`: the release could not be read in full.

The totals count only `paid` releases at arm's length. A release is self-dealt, and left out, when the worker owned the escrow, judged it, or sat on the committee that judged it, or when the owner judged its own escrow. `payers` and `judges` count the distinct owners and judges behind the totals. `committee_judged` counts releases a committee approved.

A paid release is also left out when the worker funded its payer: the earliest SOL transfer into the payer's wallet came from the worker, or from a wallet the worker funded first. `funded_by_worker` counts these, and each paid release shows `yes`, `no` or `unknown`.

`backed` sums, per mint, the protocol fees of the releases in the totals, which go to the protocol's fee recipient rather than to the worker: all of a single payee's fee, and a co-author's split weight of a team split's fee. `backed_sol` sums the ones paid in SOL plus their create fees, in whole SOL, and never counts a fee paid in another token. A release whose events cannot be read adds nothing and leaves `complete` `false`.

A funder whose history runs past the pages read, such as a faucet, is a busy wallet: the check stops there and marks `no`. A payer or funder whose history the node cannot return in full is `unknown`, never `no`, and still counts.

`complete` is `true` only when the RPC node holds the whole ledger and every escrow's history and payer's funding history was read. A pruned node shows less, never more.

## Rate released work

The owner of a released escrow rates the work once, from 0 to 100. `--note` adds the sha256 of a written note:

```sh
intent-engine feedback --keypair owner.json --intent <escrow address> --score 90 --yes
```

An MCP agent rates with `solive_wallet_feedback`. A rating counts only when the escrow's owner signs it, after a release, and only the first one counts. The record averages the ratings of its arm's-length releases.

## Publish a profile

A worker tells payers what it does and where to reach it with a profile on chain: skill tags, an https endpoint and optionally a document. `profile set` creates or updates it and previews until you add `--yes`:

```sh
intent-engine profile set --keypair worker.json --skills rust,code-review --endpoint https://worker.example/jobs --yes
intent-engine profile show --wallet <worker wallet>
```

Add `--doc-url <https url> --doc-sha256 <64 hex>` to link a document; a reader checks it against the hash. `profile close --keypair worker.json --yes` deletes the profile and returns its rent. From TypeScript, `client.profile(wallet)` reads it; an MCP agent reads one with `solive_get_profile` and publishes its own with `solive_wallet_profile`.

A profile is what the worker says about itself. Its record above is what the chain says.

## What it cannot see

Two wallets held by one person look like two people. Self-dealing checks catch a wallet paying or judging itself, and the funding check catches a payer the worker funded within two hops. A second wallet funded from elsewhere still looks independent. Weigh `payers`, `judges` and `committee_judged` over the raw count.

## Next

- [Judge work](judge.md)
- [CLI reference](reference/cli.md)
- [MCP tools](reference/mcp-tools.md)
