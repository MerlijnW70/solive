# Connect an AI agent

Serve the engine to an AI agent as MCP tools over stdio. Complete [step 1 of the quickstart](quickstart.md#1-install) first.

## 1. Add the server to your MCP client

Add this entry to your client's `mcpServers` configuration. Replace `/path/to/solive` with the absolute path of your clone:

```json
{
  "mcpServers": {
    "solive": {
      "command": "node",
      "args": ["/path/to/solive/packages/cli/dist/src/bin.js", "mcp", "--url", "devnet"]
    }
  }
}
```

Restart the client. Its tool list now shows the `solive_` tools.

## 2. What the agent can do

With this entry the server holds no keys. Its tools read the engine and prepare unsigned transactions. A person's wallet signs and sends every transaction, and nothing moves until then.

Add `--wallet` to let the server keep its own devnet wallet and trade from it after the user approves, as [Use it from your AI](ai.md) shows. Add `--relayer` with `--relay-fee` to let `solive_submit_signed_intent` create intents owners signed off-chain, with the relayer key paying.

Amounts are raw base units. `solive_get_balances` returns each token's decimals.

## 3. Let the agent act on its own

To let the agent create intents without a wallet signature each time:

1. The owner grants the agent key a mandate with `intent-engine mandate grant`, as [the mandate guide](mandate.md) shows. The mandate caps what the agent may sell, for how much, and until when, and the program enforces every limit.
2. Start the server with the agent key and the owners it may act for:

```json
"args": ["/path/to/solive/packages/cli/dist/src/bin.js", "mcp", "--url", "devnet", "--agent", "/path/to/agent-keypair.json", "--agent-owners", "OWNER_ADDRESS"]
```

The server then signs and pays with the agent key through `solive_agent_create`, only for the listed owners.

## Reference

- [MCP tools](reference/mcp-tools.md): every tool, its parameters and what it does
- [Errors](reference/errors.md): every problem code a tool can return
