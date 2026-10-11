# Use it from your AI

You need Node.js 22.12 or later. Devnet tokens have no value.

## 1. Add the server

Claude Code:

```sh
claude mcp add solive -- npx -y @intent-engine/cli mcp --url devnet --wallet
```

Other apps: add this to the app's MCP settings and restart it.

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

It sends nothing until you say yes.
