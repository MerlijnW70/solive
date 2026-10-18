# Server options

Ways to run `intent-engine mcp`, the server that [Use it from your AI](ai.md) adds.

With `--wallet` the server serves only the everyday tools; add `--all-tools` to serve every tool, such as the committee, claim and profile tools.

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

With this entry the server holds no keys. Its tools read the engine and prepare unsigned transactions. A person's wallet signs and sends every transaction.

These tools take amounts in base units; `solive_get_balances` returns each token's decimals. The `--wallet` tools take whole tokens.

## Let an agent act for you

1. Give the agent key a mandate, as [the mandate guide](mandate.md) shows. The program enforces its limits.
2. Start the server with that key and the owners it may act for:

```json
"args": ["-y", "@intent-engine/cli", "mcp", "--url", "devnet", "--agent", "/path/to/agent-keypair.json", "--agent-owners", "OWNER_ADDRESS"]
```

The agent then creates intents with `solive_agent_create`, only for those owners.

## Deliver work

1. `solive_find_jobs` lists open jobs.
2. `solive_prepare_deliver` returns a transaction that announces your work. Your wallet signs it.
3. The judge checks it with `solive_check_delivery` and pays, as [Judge work](judge.md) shows.
4. `solive_get_receipt` shows who was paid.

## Relay signed intents

`--relayer` with `--relay-fee` lets `solive_submit_signed_intent` publish intents that owners signed off-chain. The relayer key pays.

## All options

- [The mcp command](reference/cli.md#mcp)
- [All MCP tools](reference/mcp-tools.md)
- [Errors](reference/errors.md)
