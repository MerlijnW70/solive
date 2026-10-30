# Use it from your AI

Let your AI assistant swap, pay and escrow on Solana devnet. It asks you before it sends anything. Devnet tokens have no value.

You need Node.js 22.12 or later, and the app you add the server to, such as Claude Code or Codex, installed first: `add-to` runs that app's own command.

## 1. Add the server

Run one of these in a terminal, not in the AI chat, then restart the app.

Claude Code, on any system:

```sh
npx -y @intent-engine/cli add-to claude
```

It runs `claude mcp add --scope user` with the server command your system needs, so the server is there in every project. When npm's registry, or the one set for `@intent-engine`, is `http://`, `add-to` adds nothing and prints the command that switches it to `https://registry.npmjs.org/`.

Codex, on any system:

```sh
npx -y @intent-engine/cli add-to codex
```

It runs `codex mcp add` the same way, then gives the server time in `~/.codex/config.toml` to start on its first run.

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

> Find a job I can do, read its spec, do the work and announce it.

> Post a job for a word count: escrow 2 TEST, publish the spec, and I will judge it.

It swaps, escrows, releases or cancels nothing until you say yes.

Every app on your computer uses the same wallet, the one `setup` names. Ask your AI for its balance to see it. It needs devnet SOL: the setup tool asks the instant faucet first, then devnet, and [Devnet SOL](quickstart.md#devnet-sol) lists the other ways.

When the server starts, it prints a line that starts with `info: releases are checked against one RPC node`. It is a note, not an error; [A second node](mcp.md#a-second-node) shows how to set `--confirm-url`.

## Earn and hire

Do a job: `find_jobs` lists open jobs, and says so when none is open: ask it to wait for one, or post one yourself as below. Then `get_spec` reads one (work on it only when it matches), `hash` gives your work's sha256, `wallet_deliver` announces it to the judge, and `wallet_receipt` shows whether you were paid. Pay in SOL arrives as wrapped SOL; `wallet_unwrap` turns it into SOL. Use `get_reputation` to weigh a worker before you hire.

Post a job: `hash` your spec, host it at a public url, then `wallet_escrow` locks the pay with that spec_hash and spec_url and names your judge wallet. When work is announced, `wallet_check_delivery` lists it, `wallet_fetch_work` fetches it and `wallet_attest` pays the first announcement that opens to it; `wallet_attest_split` pays several co-authors by weight; a co-author whose token account cannot take its share claims it later with `wallet_claim_held`. `wallet_feedback` rates the work after you pay.

## 3. Cap what it sells (optional)

```sh
npx -y @intent-engine/cli add-to claude --wallet-per-trade SOL=0.1 --wallet-per-hour SOL=0.5
```

The server then refuses to sell more than that per trade or per hour, whatever it is asked. If you added it already, run `claude mcp remove solive` first.

## More

- [Server options](mcp.md): no wallet, agent mandates, delivering work
- [All MCP tools](reference/mcp-tools.md)
