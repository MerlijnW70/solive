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

`--issue` prices 200 of your token per wrapped SOL and mints them into the fill. The ratio is in raw units, so it means 200 per SOL because both tokens have 9 decimals, and it prices the escrow left after the protocol fee. `--min-profit` takes raw units, so the solver skips any fill that leaves it less than 1 raw unit. `solve` makes one pass over the open intents and prints the ones it filled, sent, skipped and failed. To keep solving, add `--watch`: it stays running, solves again as soon as an intent changes on chain and at least every `--interval` seconds (default 5), and prints only the rounds that send or fail, as [the devnet filler](../scripts/filler.sh) does. It sends each fill without waiting for it to confirm, so its fills show as sent; check them with `intent-engine list`.

Profit counts only the output token, so `solve` also counts what each fill costs in SOL before it sends it: 5000 lamports per signature, the priority fee (unit price times compute limit), the `--tip` and the rent of every token account the fill opens for the solver. It skips a fill that costs more than `--max-sol-cost`, in SOL with at most 9 decimals, default 0.01. `--min-profit` refuses 0 for any mint, and a fixed `--priority-fee` is at most 10000000 micro-lamports per compute unit, the cap of `auto`. With `--watch`, an intent whose fill failed is skipped for 1 pass, then 2, 4 and so on up to 32 passes while it keeps failing; the count resets after a fill or when the intent changes on chain.

## 5. Check the balances

```sh
spl-token balance $TOKEN
spl-token balance $TOKEN --owner $(solana-keygen pubkey ~/solive-solver.json)
spl-token balance So11111111111111111111111111111111111111112 --owner $(solana-keygen pubkey ~/solive-solver.json)
```

Your wallet prints `5`. The solver keeps the rest of what it minted as its profit, and receives the escrowed wrapped SOL less the protocol fee.

## Solve from TypeScript

Instead of step 4, write the solver yourself with the npm packages. Do steps 1 to 3, then install them with Node.js 22.12 or later:

```sh
npm install @intent-engine/core @intent-engine/client @solana/kit @solana-program/token
```

Paste the TypeScript blocks below, in order, into one file `solver.mts` and run it with `node --experimental-strip-types solver.mts`. It loads the solver key and your token's address from the files steps 1 and 2 made.

```ts
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { getMintToInstruction } from "@solana-program/token";
import { createClient } from "@intent-engine/client";
import { findAssociatedTokenAddress, formatAmount, IntentStatus, NATIVE_MINT, termsOf, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";

const key = async (file: string) => createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(await readFile(`${homedir()}/${file}`, "utf8"))));
const client = createClient({ url: "https://api.devnet.solana.com" });
const solver = await key("solive-solver.json");
const token = (await key("solive-token.json")).address;
```

`intents({ status: IntentStatus.Open })` lists every open intent. `termsOf`, given the chain's time from `chainTime`, says what each one sells and the least it must receive now. This solver takes the intents that sell wrapped SOL for your token, belong to another wallet and have not expired, and fills those that ask at most 200 of your token per SOL sold; both tokens have 9 decimals, so the raw amounts compare directly.

`fill` fills one intent from the solver's wallet. It reads the intent and the engine's config, fills the whole escrow, creates any missing token account the fill needs, the solver's and the fee recipient's included, at the solver's cost, and passes the fee recipient the config names, the treasury wallet: the engine refuses a fill without it whenever the protocol fee is above zero. It delivers the least the intent receives at the chain's time unless `amountOut` says more, and `route` runs instructions before the fill in the same transaction, here a mint of exactly what it delivers. `fillOf` reads the fill back from the intent's history. This prints what the fill delivered and the wrapped SOL the solver received, the escrow less the protocol fee: 5 and 0.049975 for the intent from step 3.

```ts
const now = await client.chainTime();
const open = await client.intents({ status: IntentStatus.Open });
const output = await findAssociatedTokenAddress({ owner: solver.address, mint: token, tokenProgram: TOKEN_PROGRAM_ADDRESS });
for (const { address, intent } of open) {
  if (intent.inputMint !== NATIVE_MINT || intent.outputMint !== token || intent.owner === solver.address || now >= intent.expiresAt) {
    continue;
  }
  const { sells, receivesAtLeast } = termsOf(intent, now);
  if (receivesAtLeast === null || receivesAtLeast > sells * 200n) {
    continue;
  }
  const route = [getMintToInstruction({ mint: token, token: output, mintAuthority: solver, amount: receivesAtLeast })];
  await client.fill({ solver, owner: intent.owner, nonce: intent.nonce, amountOut: receivesAtLeast, route });
  const fill = await client.fillOf(address);
  console.log(formatAmount(fill?.delivered ?? 0n, 9), formatAmount(fill?.net ?? 0n, 9));
}
```

`balances` reads a wallet's SOL and, for each mint, its token account, with 0 for an account it lacks; `name` is `SOL` for wrapped SOL and `undefined` for your token. Fills pay the solver in wrapped SOL, and `unwrap` closes that account so its balance returns to the wallet as SOL. This prints the solver's wrapped SOL and your token, then the wallet's SOL after the unwrap.

```ts
const { tokens } = await client.balances(solver.address, [NATIVE_MINT, token]);
for (const { mint, name, amount, decimals } of tokens) {
  console.log(name ?? mint, formatAmount(amount, decimals));
}
await client.unwrap(solver);
console.log(formatAmount((await client.balances(solver.address, [])).sol, 9));
```

## Next

- [CLI reference](reference/cli.md)
