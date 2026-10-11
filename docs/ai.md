# Use it from your AI

You need Node.js 22.12 or later. Devnet tokens have no value.

## 1. Add the server

Claude Code:

```sh
claude mcp add solive -- npx -y @intent-engine/cli mcp --url devnet --wallet
```

Codex:

```sh
codex mcp add solive -- npx -y @intent-engine/cli mcp --url devnet --wallet
```

VS Code:

```sh
code --add-mcp '{"name":"solive","command":"npx","args":["-y","@intent-engine/cli","mcp","--url","devnet","--wallet"]}'
```

Cursor: put this in `~/.cursor/mcp.json`. Other apps: add it to the app's MCP settings. Then restart the app.

```json
{
  "mcpServers": {
    "solive": {
      "command": "npx",
      "args": ["-y", "@intent-engine/cli", "mcp", "--url", "devnet", "--wallet"]
    }
  }
}
```

## 2. Ask your AI

> Set me up on solive and make my first swap.

For a better price, let the asked amount fall until a solver takes it:

> Sell 0.05 SOL in a Dutch auction, asking 12 TEST and falling to 9.5 over a few minutes.

Or repeat a trade on a schedule:

> Buy TEST with 0.05 SOL every hour, five times, for at least 9.5 TEST each.

It swaps, auctions or cancels nothing until you say yes.

Before a trade it can estimate the price from recent fills. After a send it waits for the fill and tells you what you received.

To cap what it may sell, whatever it is asked, add limits to the server's arguments:

```sh
claude mcp add solive -- npx -y @intent-engine/cli mcp --url devnet --wallet --wallet-per-trade SOL=0.1 --wallet-per-hour SOL=0.5
```

It then sells only the tokens named, at most that much per trade and per rolling hour. The server enforces them when it signs; only a restart changes them.

## 3. Let your AI explain any trade (optional)

The Solana Explorer server decodes any address or transaction, solive's instructions included, so your AI can explain what a swap did. It is read-only and holds no keys.

Claude Code:

```sh
claude mcp add --transport http solana-explorer https://explorer.solana.com/mcp
```

Codex:

```sh
codex mcp add solana-explorer --url https://explorer.solana.com/mcp
```

VS Code:

```sh
code --add-mcp '{"name":"solana-explorer","type":"http","url":"https://explorer.solana.com/mcp"}'
```
