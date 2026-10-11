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

It swaps or cancels nothing until you say yes.
