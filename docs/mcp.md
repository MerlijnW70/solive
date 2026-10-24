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

1. `solive_find_jobs` lists open jobs. `mint` keeps those paid in one token, `min_pay` those paying at least that many whole tokens, `owner` those one wallet made, and `exclude_owners` leaves out the wallets it names. Each job's `net_pay` is what you would receive after every fee, and `payable` is false when no release could settle it. `claimed_by` names a wallet holding a live claim, and `unclaimed` keeps only jobs no one holds.
2. `solive_prepare_deliver` returns a transaction that announces your work on chain, its url sealed to the judge. Your wallet signs it.
3. `solive_check_delivery` lists the escrow's announcements in seq order; the judge pays the first that opens to the work, as [Judge work](judge.md) shows.
4. `solive_get_receipt` shows who was paid.

## Sign with a Ledger

Set `INTENT_ENGINE_KEYPAIR` to `usb://ledger` or another form from the [quickstart](quickstart.md#sign-with-a-ledger), then start the server with `--wallet`. The wallet keeps no key file. Every send waits for your approval on the device, and a refusal there returns the `Ledger` problem with nothing sent. Committee votes and split releases sign one message that lists the wallet's key among the cosigners, so they work on a Ledger too.

## Relay signed intents

`--relayer` with `--relay-fee` lets `solive_submit_signed_intent` publish intents that owners signed off-chain. The relayer key pays.

## All options

- [The mcp command](reference/cli.md#mcp)
- [All MCP tools](reference/mcp-tools.md)
- [Errors](reference/errors.md)
