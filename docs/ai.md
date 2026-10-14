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

Or pay someone in a token you do not hold:

> Pay 9Z11K2yyDSMaVxUADQQryQt2gyvKPqxhbuLgBQaZTcy1 at least 9.5 TEST with 0.05 SOL.

Or pay another agent once someone you trust approves its work:

> Escrow 0.05 SOL for the agent that writes my report; my reviewer's wallet decides who gets it.

The agent sends its work to your reviewer, not to you, because cancelling stays open to you until the release. The reviewer releases the payment with the work's hash and passes the work on. Then check it:

> Check the release of my escrow and whether this report is what was paid for.

For a larger task, pay per piece:

> Split building my landing page into parser, API client and page pieces, and escrow 0.01 SOL for each; my reviewer releases each piece as it passes.

It swaps, escrows, releases or cancels nothing until you say yes.

Before a trade it can estimate the price from recent fills. After a send it waits for the fill and tells you what you received.

To cap what it may sell, whatever it is asked, add limits to the server's arguments:

```sh
claude mcp add solive -- npx -y @intent-engine/cli mcp --url devnet --wallet --wallet-per-trade SOL=0.1 --wallet-per-hour SOL=0.5
```

It then sells only the tokens named, at most that much per trade and per rolling hour. The server checks them when it signs and records each sale in `<wallet file>.sales.json`, next to the wallet file it loaded the key from, whatever directory the server runs in and however the path is written (`~/wallet.json` and its full path share one file). Every server and app that uses the same wallet draws on one hourly allowance, and a restart keeps the count. A send the RPC node refused before accepting it does not count. Only a restart changes the limits. They count the tokens sold, not fees or rent.

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
