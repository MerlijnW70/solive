# @intent-engine/cli

Swap, escrow and judge work on Solana devnet from the command line, or let your AI do it through MCP. Devnet tokens have no value.

```sh
npm install -g @intent-engine/cli
intent-engine setup
intent-engine create swap --input-mint SOL --output-mint TEST --units tokens --amount-in 0.05 --min-out 5 --expires-in 3600
```

The last command shows what the swap does and sends nothing until you add `--yes`.

- [Quickstart](https://merlijnw70.github.io/solive/quickstart)
- [Use it from your AI](https://merlijnw70.github.io/solive/ai)
- [Judge work](https://merlijnw70.github.io/solive/judge)
- [All commands](https://merlijnw70.github.io/solive/reference/cli)
