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

OpenClaw keeps its servers under `mcp.servers` instead; [Use it from OpenClaw](openclaw.md) gives its entry and how to make every call ask first.

## 2. What the agent can do

With this entry the server holds no keys. Its tools read the engine and prepare unsigned transactions. A person's wallet signs and sends every transaction, and nothing moves until then.

Add `--wallet` to let the server keep its own devnet wallet and trade from it after the user approves, as [Use it from your AI](ai.md) shows; `--wallet-per-trade` and `--wallet-per-hour` cap what it sells. Add `--relayer` with `--relay-fee` to let `solive_submit_signed_intent` create intents owners signed off-chain, with the relayer key paying.

The read and prepare tools served without `--wallet` take and return amounts in raw base units; `solive_get_balances` returns each token's decimals. The wallet tools `--wallet` adds take whole tokens, such as `0.05` for 0.05 SOL.

## 3. Let the agent act on its own

To let the agent create intents without a wallet signature each time:

1. The owner grants the agent key a mandate with `intent-engine mandate grant`, as [the mandate guide](mandate.md) shows. The mandate caps what the agent may sell, for how much, and until when, and the program enforces every limit.
2. Start the server with the agent key and the owners it may act for:

```json
"args": ["/path/to/solive/packages/cli/dist/src/bin.js", "mcp", "--url", "devnet", "--agent", "/path/to/agent-keypair.json", "--agent-owners", "OWNER_ADDRESS"]
```

The server then signs and pays with the agent key through `solive_agent_create`, only for the listed owners.

## 4. Deliver work to a proof escrow

Without `--wallet`, a worker's own wallet signs the delivery:

1. `solive_find_jobs` lists open proof escrows with their spec hash and spec url.
2. `solive_prepare_deliver` takes the worker's address, the escrow, the work's sha256 and its url, and returns an unsigned transaction that announces the work to the escrow's attestor. The worker's wallet signs and sends it.
3. The attestor lists the announced work with `solive_check_delivery` and releases the escrow to the earliest announcer of the hash that passed, as [the judge guide](judge.md) shows.
4. `solive_get_receipt` shows the owner and the worker whom the release paid and which sha256 it recorded.

An owner who signs a proof escrow off-chain passes `spec_url` to `solive_prepare_signed_intent`. A relayer checks the signed terms with `solive_preview_signed_intent`, and `solive_submit_signed_intent` publishes the url in a memo the relayer signs. The url is not part of the owner's signature.

## Reference

- [MCP tools](reference/mcp-tools.md): every tool, its parameters and what it does
- [Errors](reference/errors.md): every problem code a tool can return
