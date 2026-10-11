# Let an agent trade within limits

Grant an agent key a mandate, let it create an intent on its own, then revoke it. Complete the [quickstart](quickstart.md) first and stay in the same terminal.

## 1. Create and fund the agent key

The agent key pays the rent and network fees of every intent it creates:

```sh
solana-keygen new --no-bip39-passphrase -o ~/solive-agent.json
solana transfer $(solana-keygen pubkey ~/solive-agent.json) 0.05 --allow-unfunded-recipient
```

## 2. Grant the mandate

Each limit is one option:

- `--per-intent 0.02` and `--total 0.05`: wrapped SOL the agent may sell per intent and in total
- `--max-intents 3`: how many intents it may create
- `--max-ttl 3600`: the longest an intent may live, in seconds
- `--valid-for 86400`: how long the mandate lasts, in seconds
- `--floor-out 100 --floor-in 1`: the lowest price, here 100 test tokens per wrapped SOL


```sh
intent-engine mandate grant --agent $(solana-keygen pubkey ~/solive-agent.json) --input-mint So11111111111111111111111111111111111111112 --output-mint ETU8trkkfE8gNVPDGbCaJUoH88wy6yYV6ttJdc9NKB88 --kinds swap --per-intent 0.02 --total 0.05 --max-intents 3 --max-ttl 3600 --valid-for 86400 --floor-out 100 --floor-in 1 --units tokens --yes
intent-engine mandate show --agent $(solana-keygen pubkey ~/solive-agent.json)
```

The program enforces every limit. Proceeds always go to your own token account.

## 3. Let the agent create an intent

The agent signs with its own key, for your wallet:

```sh
intent-engine mandate use swap --keypair ~/solive-agent.json --owner $(solana address) --amount-in 0.02 --min-out 2 --expires-in 3600 --units tokens --yes
```

The 0.02 wrapped SOL moves from your token account into the intent's escrow. An order below the price floor or above a cap is refused, and so is any new order after the mandate ends. Intents the agent already created stay fillable until they expire, and cancelling one does not return its share of the budget.

## 4. Revoke it

```sh
intent-engine mandate revoke --agent $(solana-keygen pubkey ~/solive-agent.json) --yes
```

Revoking cancels up to 6 of the agent's open intents in the same transaction, refunds their escrow and lowers the engine's allowance by the unused budget.

Revoking closes the mandate, so `mandate show` then reports `NotFound`.

## Next

- [Connect an AI agent](mcp.md): let an AI agent use the mandate through `solive_agent_create`
- [CLI reference](reference/cli.md)
