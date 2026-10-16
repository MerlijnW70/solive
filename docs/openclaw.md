# Use it from OpenClaw

Connect OpenClaw to the engine's MCP server on devnet. You need Node.js 22.12 or later and OpenClaw. Devnet tokens have no value.

## 1. Add the server

Merge this entry into `~/.openclaw/openclaw.json`, or `$HOME\.openclaw\openclaw.json` on Windows. [examples/openclaw/openclaw.json5](../examples/openclaw/openclaw.json5) holds the same entry:

```json5
{
  "mcp": {
    "servers": {
      "intent": {
        "command": "npx",
        "args": ["-y", "@intent-engine/cli@0.1.31", "mcp", "--url", "devnet", "--wallet", "--wallet-per-trade", "SOL=0.1", "--wallet-per-hour", "SOL=0.5"],
        "requestTimeoutMs": 60000
      }
    }
  }
}
```

The version is pinned, so an update reaches the server only when you change it. `--wallet` gives the server its own devnet wallet. `--wallet-per-trade` and `--wallet-per-hour` cap what it sells per trade and per rolling hour, whatever the agent is asked, as [Use it from your AI](ai.md) shows. `requestTimeoutMs` leaves room for `intent__solive_wallet_wait`, which waits for a fill before it answers.

On native Windows, `command` may need to be `npx.cmd`.

The tools then appear as `intent__solive_...`, such as `intent__solive_wallet_swap`.

To discover work without a wallet, start the server read-only. It holds no keys and sends nothing:

```json5
{
  "mcp": {
    "servers": {
      "intent": {
        "command": "npx",
        "args": ["-y", "@intent-engine/cli@0.1.31", "mcp", "--url", "devnet"],
        "requestTimeoutMs": 60000
      }
    }
  }
}
```

## 2. Ask before every call

OpenClaw's default posture runs MCP tools without asking. Make every tool of this server ask you first:

```sh
openclaw mcp configure intent --approval prompt
```

In PowerShell:

```powershell
openclaw mcp configure intent --approval prompt
```

Never answer "Allow Always" for an `intent__solive_wallet_*` tool. It approves that tool for any arguments, `send: true` included, so later swaps, escrows and releases go out without a question.

Shared or group agents get no wallet tools at all. Deny them in that agent's entry:

```json5
{
  "agents": {
    "list": [
      { "id": "group", "tools": { "deny": ["intent__solive_wallet_*"] } }
    ]
  }
}
```

## 3. Add the skill (optional)

[examples/openclaw/intent-engine/SKILL.md](../examples/openclaw/intent-engine/SKILL.md) teaches the agent three flows: earn, hire and swap. Copy the `intent-engine` folder into your OpenClaw skills folder. It holds only `SKILL.md`: no scripts and no commands. Read it before you install it, as you would any wallet skill.

## 4. Test it

Restart OpenClaw, then ask:

> List the open jobs on the intent engine.

The agent calls `intent__solive_find_jobs`.

> Set up my devnet wallet and preview a swap of 0.05 SOL for at least 9.5 TEST.

The agent calls `intent__solive_wallet_setup`, `intent__solive_wallet_estimate` and `intent__solive_wallet_swap` without `send`, and shows the summary. Nothing is sent yet.

> Yes, send it.

The agent calls `intent__solive_wallet_swap` with `send: true`, and OpenClaw asks you to approve that call.

> Wait for the fill.

The agent calls `intent__solive_wallet_wait` and reports what the wallet received.

## Reference

- [Connect an AI agent](mcp.md): every server option
- [MCP tools](reference/mcp-tools.md): every tool, its parameters and what it does
