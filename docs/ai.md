# Use it from your AI

Let your AI assistant swap, pay and escrow on Solana devnet. It asks you before it sends anything. Devnet tokens have no value.

You need Node.js 22.12 or later.

## 1. Add the server

Run one of these in a terminal, not in the AI chat, then restart the app.

Claude Code:

```sh
claude mcp add solive -- npx -y @intent-engine/cli mcp --url devnet --wallet
```

Claude Code on native Windows, in PowerShell or cmd, starts `npx` through `cmd /c`:

```powershell
claude mcp add solive -- cmd /c npx -y @intent-engine/cli mcp --url devnet --wallet
```

Codex stops a server that starts slowly, so install it first:

```sh
npm install -g @intent-engine/cli
codex mcp add solive -- intent-engine mcp --url devnet --wallet
```

Codex on native Windows:

```powershell
npm install -g @intent-engine/cli
codex mcp add solive -- cmd /c intent-engine mcp --url devnet --wallet
```

VS Code:

```sh
code --add-mcp '{"name":"solive","command":"npx","args":["-y","@intent-engine/cli","mcp","--url","devnet","--wallet"]}'
```

VS Code in Windows PowerShell, which needs each double quote escaped:

```powershell
code --add-mcp '{\"name\":\"solive\",\"command\":\"npx\",\"args\":[\"-y\",\"@intent-engine/cli\",\"mcp\",\"--url\",\"devnet\",\"--wallet\"]}'
```

Cursor and other apps: add this to the app's MCP settings, such as `~/.cursor/mcp.json`, then restart the app.

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

OpenClaw: see [Use it from OpenClaw](openclaw.md).

## 2. Ask

> Set me up on solive and make my first swap.

> Sell 0.05 SOL in a Dutch auction, asking 12 TEST and falling to 9.5 over a few minutes.

> Buy TEST with 0.05 SOL every hour, five times, for at least 9.5 TEST each.

> Escrow 0.05 SOL for the agent that writes my report; my reviewer's wallet decides who gets it.

It swaps, escrows, releases or cancels nothing until you say yes.

Every app on your computer uses the same wallet, the one `setup` names. Ask your AI for its balance to see it.

## 3. Cap what it sells (optional)

```sh
claude mcp add solive -- npx -y @intent-engine/cli mcp --url devnet --wallet --wallet-per-trade SOL=0.1 --wallet-per-hour SOL=0.5
```

On native Windows:

```powershell
claude mcp add solive -- cmd /c npx -y @intent-engine/cli mcp --url devnet --wallet --wallet-per-trade SOL=0.1 --wallet-per-hour SOL=0.5
```

The server then refuses to sell more than that per trade or per hour, whatever it is asked.

## More

- [Server options](mcp.md): no wallet, agent mandates, delivering work
- [All MCP tools](reference/mcp-tools.md)
