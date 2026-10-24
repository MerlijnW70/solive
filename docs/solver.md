# Run a solver

Fill other people's orders on devnet and keep the difference. Devnet has no market to buy from, so you issue your own token and pay out in what you mint.

Do steps 1 and 2 of the [quickstart](quickstart.md) first. You also need the Solana CLI, including `spl-token`.

## 1. Create a solver key

The solver must be a different key from the owner of the intents it fills.

```sh
solana config set --url devnet --keypair ~/.config/intent-engine/wallet.json
solana-keygen new --no-bip39-passphrase -o ~/solive-solver.json
solana transfer $(solana-keygen pubkey ~/solive-solver.json) 0.03 --allow-unfunded-recipient
```

In PowerShell:

```powershell
solana config set --url devnet --keypair $HOME/.config/intent-engine/wallet.json
solana-keygen new --no-bip39-passphrase -o $HOME/solive-solver.json
solana transfer $(solana-keygen pubkey $HOME/solive-solver.json) 0.03 --allow-unfunded-recipient
```

## 2. Issue a token

The solver key can mint it.

```sh
solana-keygen new --no-bip39-passphrase -o ~/solive-token.json
spl-token create-token --decimals 9 ~/solive-token.json --fee-payer ~/solive-solver.json --mint-authority $(solana-keygen pubkey ~/solive-solver.json)
export TOKEN=$(solana-keygen pubkey ~/solive-token.json)
```

In PowerShell:

```powershell
solana-keygen new --no-bip39-passphrase -o $HOME/solive-token.json
spl-token create-token --decimals 9 $HOME/solive-token.json --fee-payer $HOME/solive-solver.json --mint-authority $(solana-keygen pubkey $HOME/solive-solver.json)
$env:TOKEN = solana-keygen pubkey $HOME/solive-token.json
```

## 3. Create an order for it

Sell 0.05 wrapped SOL for at least 5 of your token:

```sh
intent-engine create swap --input-mint SOL --output-mint $TOKEN --units tokens --amount-in 0.05 --min-out 5 --expires-in 3600 --yes
```

In PowerShell:

```powershell
intent-engine create swap --input-mint SOL --output-mint $env:TOKEN --units tokens --amount-in 0.05 --min-out 5 --expires-in 3600 --yes
```

## 4. Solve

```sh
intent-engine solve --keypair ~/solive-solver.json --issue So11111111111111111111111111111111111111112:$TOKEN=200/1 --min-profit $TOKEN=1
```

In PowerShell:

```powershell
intent-engine solve --keypair $HOME/solive-solver.json --issue "So11111111111111111111111111111111111111112:$env:TOKEN=200/1" --min-profit "$env:TOKEN=1"
```

`--issue` prices 200 of your token per wrapped SOL and mints them into the fill. `--min-profit` skips fills that leave the solver less than 1 raw unit. Add `--watch` to keep solving: it solves again when an intent changes and at least every `--interval` seconds (default 5).

While watching, it reuses a price quote for `--quote-ttl` seconds (default 10, `0` turns this off). It never fills from a reused quote: it asks for a fresh one first.

`--target-profit` takes the same mint=raw pairs as `--min-profit` and waits on a Dutch auction while its profit is below the target. It fills at the floor once the auction ends within `--patience` seconds (default 30, from 0 to 3600). Other orders are judged by the floor alone.

Add `--stats` to print one JSON line after every full scan, counting the orders, quotes, cache hits, fills and skip reasons. It needs `--watch`.

`--inventory` takes the same rates as `--issue` and pays from tokens the solver already holds, with no swap. With `--issue` or `--jupiter`, it is tried first. It quotes nothing when the solver holds too little.

`--confirm-url <rpc>`, in the forms `--url` takes, rereads the intent, its vault and the solver's two token accounts from a second RPC node before each fill. When the two nodes disagree, or the second cannot be read, the fill is skipped and its reason names what differed.

`--inventory-owner <address>` fills from another key's tokens, so a stolen solver key can spend only the allowance that owner gave it. The owner sets it with `intent-engine solver float --keypair <owner file or Ledger> --delegate <solver address> --mint <mint> --amount <amount> --yes`, and `solver float show --owner <address> --delegate <solver address>` prints what each mint has left. It needs `--inventory` and takes no `--jupiter` or `--issue`.

`solver float revoke --keypair <owner file or Ledger> --mint <mint> --yes` takes the allowance back. The solver skips, with a reason, an intent whose owner is the inventory owner or whose receiver is that owner's token account, since the fill would pay the owner from its own float.

The solver fills from and is paid into the owner's token accounts, and skips a fill the allowance left cannot cover. It reports `low` when what is left cannot cover another fill as large as the largest it was asked to make.

`--concurrency` sets how many orders it plans at once (default 4, from 1 to 32). Fills are still simulated and sent one at a time, most profitable first.

With `--jito`, a solve sends its fills together in Jito bundles, and only the last transaction of each bundle pays the `--tip`. `--bundle-size` sets how many fills share a bundle (default 5, from 1 to 5).

## 5. Check the balances

```sh
spl-token balance $TOKEN
spl-token balance $TOKEN --owner $(solana-keygen pubkey ~/solive-solver.json)
spl-token balance So11111111111111111111111111111111111111112 --owner $(solana-keygen pubkey ~/solive-solver.json)
```

In PowerShell:

```powershell
spl-token balance $env:TOKEN
spl-token balance $env:TOKEN --owner $(solana-keygen pubkey $HOME/solive-solver.json)
spl-token balance So11111111111111111111111111111111111111112 --owner $(solana-keygen pubkey $HOME/solive-solver.json)
```

Your wallet prints `5`. The solver keeps the rest of what it minted as its profit, and receives the escrowed wrapped SOL less the protocol fee.

## Costs

- `--max-sol-cost` (default 0.01 SOL) skips a fill whose network fee, priority fee and tip cost more.
- A fill paid in wrapped SOL is skipped when its profit less that SOL cost is below `--min-profit`. `--sol-value <mint>=<raw>/<lamports>,...` does the same for other tokens, counting `raw` units as worth `lamports` lamports. Each filled or sent fill reports its `cost` in lamports.
- `--max-rent` (default 0.01 SOL) caps the rent of token accounts a fill opens for the solver, priced at the cluster's live rent rate. The solver keeps those accounts.
- With `--watch`, a fill that failed waits 1 interval, then 2, 4 and so on up to 32, before the solver tries it again.
- With `--watch` and no `--jito`, every scan asks the node whether each sent fill landed. A fill that failed on chain counts as failed at once and frees the tokens it held. A fill the node does not know yet stays in flight as before.

## Solve from TypeScript

Instead of step 4, write the solver yourself. Do steps 1 to 3, then install the packages:

```sh
npm install @intent-engine/core @intent-engine/client @solana/kit @solana-program/token
```

Paste the blocks below into `solver.mts` and run `node --experimental-strip-types solver.mts`.

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

This asks the node for the open intents that sell wrapped SOL for your token, takes those that ask at most 200 per SOL, and fills each one. `fill` creates any token account the fill needs and passes the fee recipient the config names, the treasury wallet: the engine refuses a fill without it whenever the protocol fee is above zero. `route` mints exactly what the fill delivers. This prints 5 and 0.049975 for the intent from step 3.

```ts
const now = await client.chainTime();
const open = await client.intents({ status: IntentStatus.Open, inputMint: NATIVE_MINT, outputMint: token });
const output = await findAssociatedTokenAddress({ owner: solver.address, mint: token, tokenProgram: TOKEN_PROGRAM_ADDRESS });
for (const { address, intent } of open) {
  if (intent.owner === solver.address || now >= intent.expiresAt) {
    continue;
  }
  const { sells, receivesAtLeast } = termsOf(intent, now);
  if (receivesAtLeast === null || receivesAtLeast > sells * 200n) {
    continue;
  }
  const route = [getMintToInstruction({ mint: token, token: output, mintAuthority: solver, amount: receivesAtLeast })];
  await client.fill({ solver, intent: address, amountOut: receivesAtLeast, route });
  const fill = await client.fillOf(address);
  console.log(formatAmount(fill?.delivered ?? 0n, 9), formatAmount(fill?.net ?? 0n, 9));
}
```

Fills pay the solver in wrapped SOL, and `unwrap` closes that account so it returns to the wallet as SOL:

```ts
const { tokens } = await client.balances(solver.address, [NATIVE_MINT, token]);
for (const { mint, name, amount, decimals } of tokens) {
  console.log(name ?? mint, formatAmount(amount, decimals));
}
await client.unwrap(solver);
console.log(formatAmount((await client.balances(solver.address, [])).sol, 9));
```

## Next

- [The solve command](reference/cli.md#solve)
