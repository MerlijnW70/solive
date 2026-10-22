# Build in TypeScript

Swap, escrow and pay for work from your own code. It runs on devnet, where tokens have no value.

## Install

You need Node.js 22.12 or later.

```sh
npm install @intent-engine/core @intent-engine/client @solana/kit
npx @intent-engine/cli setup
```

`setup` makes a devnet wallet with some SOL. Skip it if you did the quickstart.

## Run it

Paste this into `main.mts` and run `node --experimental-strip-types main.mts`:

```ts
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createKeyPairSignerFromBytes, generateKeyPairSigner } from "@solana/kit";
import { connect } from "@intent-engine/client";

const signer = await createKeyPairSignerFromBytes(
  new Uint8Array(JSON.parse(await readFile(`${homedir()}/.config/intent-engine/wallet.json`, "utf8"))),
);
const solive = await connect({ cluster: "devnet", signer });
const swapped = await solive.swap({ sell: "SOL", amount: "0.05", buy: "TEST", minReceive: "5" });
console.log(swapped.summary);
const reviewer = await generateKeyPairSigner();
const specSha256 = createHash("sha256").update("the acceptance spec the work must pass").digest("hex");
const escrow = await solive.payForWork({ amount: "0.01", judge: reviewer.address, specHash: specSha256 });
console.log(escrow.summary);
console.log((await solive.cancel({ escrow: escrow.intent! })).summary);
```

It sends real devnet transactions and prints one summary line for each: it swaps 0.05 SOL for at least 5 TEST, escrows 0.01 SOL for work that only the named judge can release, and then cancels that escrow. `intent-engine balance` then shows the TEST you received.

## What `connect` gives you

Amounts are whole tokens, such as `"0.05"`. Tokens are `SOL`, `TEST` or a mint address.

- `swap`: sell one token for at least an amount of another
- `limit`: sell at a price
- `payForWork`: escrow a payment that a judge releases
- `release`: as the judge, pay the work that passed to the first worker who announced it and opened the announcement
- `findWork` and `deliver`: as a worker, find jobs and announce your work
- `deliveries`: the announcements on an escrow, with each worker and whether it opened
- `receipt`: the release of an escrow, whom it paid, the work it recorded and whether it is valid
- `cancel`: get an escrow back
- `balance` and `watch`: read your wallet and follow your orders

Pass `preview: true` to a call that sends to see what it does.

## Next

- [The full client](sdk-client.md): every option, in base units
- [Judge work](judge.md)
- [Run a solver](solver.md)
