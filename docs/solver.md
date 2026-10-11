# Run a solver

Fill intents yourself on devnet. Devnet has no market to buy from, so you issue a token and pay out in what you mint. Do steps 1 to 4 of the [quickstart](quickstart.md) first, in the same terminal.

## 1. Create a solver key

The solver must be a different key from the owner of the intents it fills.

```sh
solana-keygen new --no-bip39-passphrase -o ~/solive-solver.json
solana transfer $(solana-keygen pubkey ~/solive-solver.json) 0.03 --allow-unfunded-recipient
```

## 2. Issue a token

The solver key is the token's mint authority, so the solver can mint it.

```sh
solana-keygen new --no-bip39-passphrase -o ~/solive-token.json
spl-token create-token --decimals 9 ~/solive-token.json --fee-payer ~/solive-solver.json --mint-authority $(solana-keygen pubkey ~/solive-solver.json)
export TOKEN=$(solana-keygen pubkey ~/solive-token.json)
```

## 3. Create an intent for it

Sell 0.05 wrapped SOL for at least 5 of your token:

```sh
intent-engine create swap --input-mint So11111111111111111111111111111111111111112 --output-mint $TOKEN --units tokens --amount-in 0.05 --min-out 5 --expires-in 3600 --yes
```

The devnet filler only fills the test token, so this intent stays open until you solve it.

## 4. Solve

```sh
intent-engine solve --keypair ~/solive-solver.json --issue So11111111111111111111111111111111111111112:$TOKEN=200/1 --min-profit $TOKEN=1
```

`--issue` prices 200 of your token per wrapped SOL and mints them into the fill. `--min-profit` takes raw units, so the solver skips any fill that leaves it less than 1 raw unit. `solve` makes one pass over the open intents and prints the ones it filled. To keep solving, run it in a loop, as [the devnet filler](../scripts/filler.sh) does.

## 5. Check the balances

```sh
spl-token balance $TOKEN
spl-token balance $TOKEN --owner $(solana-keygen pubkey ~/solive-solver.json)
spl-token balance So11111111111111111111111111111111111111112 --owner $(solana-keygen pubkey ~/solive-solver.json)
```

Your wallet prints `5`. The solver keeps the rest of what it minted as its profit, and receives the escrowed wrapped SOL less the protocol fee.

## Next

- [CLI reference](reference/cli.md)
