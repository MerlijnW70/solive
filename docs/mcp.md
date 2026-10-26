# Server options

Ways to run `intent-engine mcp`, the server that [Use it from your AI](ai.md) adds.

With `--wallet` the server serves the everyday tools, the committee and profile tools among them, and its instructions end with an index of them by task. Add `--all-tools` to serve every tool, such as the read and unsigned-transaction tools.

## Without a wallet

```json
{
  "mcpServers": {
    "solive": {
      "command": "npx",
      "args": ["-y", "@intent-engine/cli", "mcp", "--url", "devnet"]
    }
  }
}
```

With this entry the server holds no keys. Its tools read the engine and prepare unsigned transactions. A person's wallet signs and sends every transaction, and nothing moves until then.

These tools take amounts in base units; `solive_get_balances` returns each token's decimals. The `--wallet` tools take whole tokens.

## Let an agent act for you

1. Give the agent key a mandate, as [the mandate guide](mandate.md) shows. The program enforces its limits.
2. Start the server with that key and the owners it may act for:

```json
"args": ["-y", "@intent-engine/cli", "mcp", "--url", "devnet", "--agent", "/path/to/agent-keypair.json", "--agent-owners", "OWNER_ADDRESS"]
```

The agent then creates intents with `solive_agent_create`, only for those owners.

## Deliver work

With `--wallet`, the setup `add-to` installs, the server does the whole job and signs with your wallet:

1. `solive_find_jobs` lists open jobs. `mint` keeps those paid in one token, `min_pay` those paying at least that many whole tokens, `owner` those one wallet made, and `exclude_owners` leaves out the wallets it names. Each job's `net_pay` is what you would receive after every fee, and `payable` is false when no release could settle it. `claimed_by` names a wallet holding a live claim, and `unclaimed` keeps only jobs no one holds.
2. With no open job, `solive_find_jobs` says so, and `wait`, in seconds, waits for one.
3. `solive_get_spec` reads a job's spec and says whether it matches the job's hash. `solive_wallet_claim` claims a job that takes claims.
4. `solive_wallet_deliver` announces your work on chain, its url sealed to the judge.
5. `solive_wallet_check_delivery` lists the escrow's announcements in seq order; the judge pays the first that opens to the work, as [Judge work](judge.md) shows.
6. `solive_wallet_receipt` shows who was paid.

The server without a wallet holds no keys, so it has `solive_prepare_deliver` instead of `solive_wallet_deliver`: it returns the announcement as a transaction your wallet signs. It reads with `solive_check_delivery` and `solive_get_receipt` instead of `solive_wallet_check_delivery` and `solive_wallet_receipt`.

## A second node

With `--wallet`, the server prints a line that starts with `info: releases are checked against one RPC node` when it starts. It is a note, not an error: the server works, and on devnet one node is enough.

To have a second node confirm each release the server signs, add `"--confirm-url", "<rpc>"` to the server's `args`, or save it once for every app with `npx -y @intent-engine/cli setup --confirm-url <rpc>`. `<rpc>` is another node on the same cluster, such as a provider's devnet url; [Judge work](judge.md#check-a-second-node) says what it checks.

## Sign with a Ledger

Set `INTENT_ENGINE_KEYPAIR` to `usb://ledger` or another form from the [quickstart](quickstart.md#sign-with-a-ledger), then start the server with `--wallet`. The wallet keeps no key file. Every send waits for your approval on the device, and a refusal there returns the `Ledger` problem with nothing sent. Committee votes and split releases sign one message that lists the wallet's key among the cosigners, so they work on a Ledger too.

## Relay signed intents

`--relayer` with `--relay-fee` lets `solive_submit_signed_intent` publish intents that owners signed off-chain. The relayer key pays.

## All options

- [The mcp command](reference/cli.md#mcp)
- [All MCP tools](reference/mcp-tools.md)
- [Errors](reference/errors.md)
