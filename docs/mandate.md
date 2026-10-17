# Let an agent trade within limits

Give an agent its own key and a budget it cannot exceed, let it trade on its own, then take the budget back. Do steps 1 and 2 of the [quickstart](quickstart.md) first. You also need the Solana CLI.

## 1. Create and fund the agent key

The agent key pays the rent, network fees, create fee and crank bounty of every intent it creates:

```sh
solana config set --url devnet --keypair ~/.config/intent-engine/wallet.json
solana-keygen new --no-bip39-passphrase -o ~/solive-agent.json
solana transfer $(solana-keygen pubkey ~/solive-agent.json) 0.05 --allow-unfunded-recipient
```

In PowerShell:

```powershell
solana config set --url devnet --keypair $HOME/.config/intent-engine/wallet.json
solana-keygen new --no-bip39-passphrase -o $HOME/solive-agent.json
solana transfer $(solana-keygen pubkey $HOME/solive-agent.json) 0.05 --allow-unfunded-recipient
```

## 2. Grant the mandate

Each limit is one option:

- `--per-intent 0.02` and `--total 0.05`: wrapped SOL the agent may sell per intent and in total
- `--max-intents 3`: how many intents it may create
- `--max-ttl 3600`: the longest an intent may live, in seconds
- `--valid-for 86400`: how long the mandate lasts, in seconds
- `--floor-out 100 --floor-in 1`: the lowest price, here 100 test tokens per wrapped SOL


```sh
intent-engine mandate grant --agent $(solana-keygen pubkey ~/solive-agent.json) --input-mint SOL --output-mint TEST --kinds swap --per-intent 0.02 --total 0.05 --max-intents 3 --max-ttl 3600 --valid-for 86400 --floor-out 100 --floor-in 1 --units tokens --yes
intent-engine mandate show --agent $(solana-keygen pubkey ~/solive-agent.json)
```

In PowerShell:

```powershell
intent-engine mandate grant --agent $(solana-keygen pubkey $HOME/solive-agent.json) --input-mint SOL --output-mint TEST --kinds swap --per-intent 0.02 --total 0.05 --max-intents 3 --max-ttl 3600 --valid-for 86400 --floor-out 100 --floor-in 1 --units tokens --yes
intent-engine mandate show --agent $(solana-keygen pubkey $HOME/solive-agent.json)
```

The program enforces every limit. Proceeds always go to your own token account.

## 3. Let the agent create an intent

The agent signs with its own key, for your wallet:

```sh
intent-engine mandate use swap --keypair ~/solive-agent.json --owner $(solana address) --amount-in 0.02 --min-out 2 --expires-in 3600 --units tokens --yes
```

In PowerShell:

```powershell
intent-engine mandate use swap --keypair $HOME/solive-agent.json --owner $(solana address) --amount-in 0.02 --min-out 2 --expires-in 3600 --units tokens --yes
```

The 0.02 wrapped SOL moves from your token account into the intent's escrow. An order below the price floor, above a cap or after the mandate ends is refused.

## 4. Revoke it

```sh
intent-engine mandate revoke --agent $(solana-keygen pubkey ~/solive-agent.json) --yes
```

In PowerShell:

```powershell
intent-engine mandate revoke --agent $(solana-keygen pubkey $HOME/solive-agent.json) --yes
```

Revoking lowers the engine's allowance by the unused budget in one transaction, then cancels up to 6 of the agent's open intents in one transaction each and refunds their escrow. Cancels it could not make are listed under `skipped`, `failed` or `unknown`; cancel those with `intent-engine cancel`.

Revoking closes the mandate, so `mandate show` then reports `NotFound`.

## Next

- [Server options](mcp.md): let an AI agent use the mandate through `solive_agent_create`
- [CLI reference](reference/cli.md)
