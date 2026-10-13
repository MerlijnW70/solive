# Build on the engine from TypeScript

Create, watch, cancel and settle intents from your own code with the npm packages. This page runs on devnet: devnet SOL and the test token have no value, and the program has not had an external audit. CI runs every TypeScript block on this page, in order, as one program.

## Install

Node.js 22.12 or later.

```sh
npm install @intent-engine/core @intent-engine/client @solana/kit
```

Paste the TypeScript blocks below, in order, into one file `main.mts` and run it with `node --experimental-strip-types main.mts`. Later blocks use names earlier blocks define.

## Connect

The code pays from a devnet wallet that holds devnet SOL. Make one with the Solana CLI:

```sh
solana-keygen new --no-bip39-passphrase -o ~/solive-wallet.json
solana config set --url devnet --keypair ~/solive-wallet.json
solana airdrop 1
```

```ts
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { createClient } from "@intent-engine/client";

const client = createClient({ url: "https://api.devnet.solana.com" });
const signer = await createKeyPairSignerFromBytes(
  new Uint8Array(JSON.parse(await readFile(`${homedir()}/solive-wallet.json`, "utf8"))),
);
```

## Create a swap intent

Sell 0.05 SOL for at least 50 test tokens. The devnet filler prices test tokens at 200 per wrapped SOL and pays exactly the minimum asked; 50 is more than 0.05 SOL buys at that price, so the intent stays open until you cancel it. `createIntent` does its own setup in the same transaction: it registers the wallet on its first intent, wraps the SOL the escrow needs, and creates the token account that receives the test token. It picks the next free nonce and expires the intent in an hour unless you pass `nonce`, `expiresIn` or `expiresAt`.

```ts
import { DEVNET_TEST_MINT, Kind, NATIVE_MINT, parseAmount } from "@intent-engine/core";

const sell = await client.mint(NATIVE_MINT);
const buy = await client.mint(DEVNET_TEST_MINT);
const order = { signer, inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT };
const swap = { kind: Kind.SwapExactIn, amountIn: parseAmount("0.05", sell.decimals), minOut: parseAmount("50", buy.decimals) } as const;
const { nonce } = await client.createIntent({ ...order, params: swap });
```

## Read

`intents({ owner })` returns every intent a wallet holds and `intent(owner, nonce)` one intent, or `null` once its account is closed. Reads after your own send wait for the slot it confirmed in. `configSummary` spells out the engine's settings: pauses, which kinds can be created and filled, and their fees. `kindName` and `statusName` name an intent's kind and status, and `termsOf` decodes what it sells and the least it receives now. This prints `SwapExactIn Open` and then the terms in tokens.

```ts
import { configSummary, formatAmount, IntentStatus, kindName, statusName, termsOf } from "@intent-engine/core";

const { createPaused, fillPaused, kinds } = configSummary(await client.config());
console.log(createPaused, fillPaused, kinds.map(({ name, create, fill, feeBps }) => `${name} ${create} ${fill} ${feeBps}`));
const mine = await client.intents({ owner: signer.address });
for (const { intent } of mine.filter(({ intent }) => intent.nonce === nonce)) {
  const { sells, receivesAtLeast } = termsOf(intent);
  console.log(kindName(intent.kind), statusName(intent.status));
  console.log(formatAmount(sells, sell.decimals), formatAmount(receivesAtLeast ?? 0n, buy.decimals));
}
```

## Watch

`watch` calls back with every intent that changed, first with the current ones, and with the addresses of intents whose accounts closed, until its signal aborts. It rereads the chain every `resyncSeconds` (a client option, default `WATCH_WAIT_SECONDS`), so a dropped notification only delays a change, and it keeps going through failed reads. A filled intent's account is closed soon after the fill, so `intent` then returns `null`. This prints `Open` now and `Cancelled` once the cancel below lands.

```ts
const controller = new AbortController();
const watched = client.watch(
  (changed) => {
    for (const { intent } of changed.filter(({ intent }) => intent.nonce === nonce)) {
      console.log(statusName(intent.status));
      if (intent.status !== IntentStatus.Open) {
        controller.abort();
      }
    }
  },
  controller.signal,
  { owner: signer.address },
);
```

## Errors

A failed call throws. `explain` names the engine error behind it, or returns `null` if the engine raised none; [engine errors](reference/engine-errors.md) lists each one and what it means for your call. An expiry in the past prints `ExpiryNotInFuture`.

```ts
const failure = await client.createIntent({ ...order, params: swap, expiresAt: 0n }).catch((error: unknown) => error);
console.log(client.explain(failure)?.name);
```

## Cancel

`cancel` returns the escrow to your wrapped SOL token account, where refunds and payouts in SOL arrive. `unwrap` closes that account so its balance returns to the wallet as SOL, and resolves to `null` when the wallet holds none.

```ts
await client.cancel(signer, nonce);
await watched;
await client.unwrap(signer);
```

## Escrow work behind a proof

An `AttestedResult` intent holds payment until its attestor, the judge, signs a result. `specHash` pins the acceptance spec the judge checks, and `judgeFee` pays the judge out of the escrow; [Who can do what](#who-can-do-what) lists what each party may do. `settleProof` is the judge's call: it signs the result over the spec and pays the worker's wallet `payTo`, creating any token account the payout needs. The judge pays the transaction unless `payer` names another signer; here your wallet pays, so the new judge key needs no SOL. In practice the judge runs this with its own key. `history` returns the engine events for one intent, newest first, each with its signature and slot, and keeps working after a filler closes the account. A fill reports `IntentFilled`, or `FillBegun` and `FillEnded` when the solver fills in two steps, as the devnet filler does; the `delivered` field of `IntentFilled` or `FillEnded` is what the owner received. An `IntentAttested` event's `net` is what the payee received. This prints `Filled`, then `IntentAttested` and the worker's pay in SOL.

```ts
import { createHash } from "node:crypto";
import { generateKeyPairSigner } from "@solana/kit";

const judge = await generateKeyPairSigner();
const worker = await generateKeyPairSigner();
const specHash = new Uint8Array(createHash("sha256").update("the acceptance spec the work must pass").digest());
const pay = parseAmount("0.01", sell.decimals);
const work = { kind: Kind.AttestedResult, amountIn: pay, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash, judgeFee: pay / 10n } as const;
const job = await client.createIntent({ ...order, params: work });
await client.settleProof({ judge, payer: signer, owner: signer.address, nonce: job.nonce, payTo: worker.address, result: 1n });
console.log(statusName((await client.intent(signer.address, job.nonce))?.intent.status ?? -1));
const paid = (await client.history(job.intent)).find((event) => event.name === "IntentAttested");
console.log(paid?.name);
console.log(formatAmount(paid?.fields.net ?? 0n, sell.decimals));
```

## Fees

Each kind has a protocol fee in basis points, `feeBps` in `configSummary`, taken from what a fill pays out of the escrow. A proof escrow pays the judge its `judgeFee` first; the protocol fee, and the fee of a partner the intent names, come out of the rest, and the worker receives what remains. `splitFees` and `feeBpsFor` from `@intent-engine/core` compute the same split. This prints what the worker, the judge and the protocol received for the proof escrow above, in SOL; the three add up to the escrow.

```ts
const received = [paid?.fields.net ?? 0n, work.judgeFee, paid?.fields.fee ?? 0n];
console.log(received.map((amount) => formatAmount(amount, sell.decimals)).join(" "));
```

## When the judge refuses

The engine has no refusal call: a judge that rejects the work sends nothing, and the escrow stays open. The owner cancels it, which returns the escrow to the wrapped SOL token account, and `unwrap` returns that to the wallet as SOL. If the owner does not, anyone can expire the intent once its expiry passes, which also returns the escrow to the owner's token account. After the cancel, `settleProof` throws `NotSettleable`. This prints `Cancelled NotSettleable`.

```ts
const refused = await client.createIntent({ ...order, params: work });
await client.cancel(signer, refused.nonce);
const late = await client.settleProof({ judge, payer: signer, owner: signer.address, nonce: refused.nonce, payTo: worker.address, result: 1n }).catch((error: unknown) => error);
console.log(statusName((await client.intent(signer.address, refused.nonce))?.intent.status ?? -1), (late as Error).name);
await client.unwrap(signer);
```

## Who can do what

- Any wallet other than the owner and the receiver can fill an open swap intent before it expires.
- Only a verdict signed by the judge the intent names settles a proof escrow; any wallet can send that signed verdict and pay for it.
- A fill or settle at or after the expiry fails with `IntentExpired`.
- Only the owner can cancel; another wallet's cancel fails with `Unauthorized`.
- The owner can cancel an open proof escrow until the judge settles it, also after it expires as long as nobody has expired it.
- After a settle, the owner's cancel fails with `InvalidTransition`.
- After a cancel, the judge's settle fails: `settleProof` throws `NotSettleable` before it sends, and the engine refuses the same transaction with `InvalidTransition`.
- Anyone can expire an open intent at or after its expiry, which returns the escrow to the owner's token account and pays the expirer the crank bounty; before the expiry it fails with `NotExpired`.
- Anyone can close a filled, cancelled or expired intent, which returns the rent of the intent and its escrow account to the wallet that paid it, the owner for `createIntent`; the closer earns the crank bounty the intent still holds, except on a cancelled intent, where it goes to that wallet too.
- Closing an open intent fails with `InvalidTransition`.

## Costs

`createIntent` pays from the signer's wallet: on its first intent, the rent of its user state account, which stays open; the rent of the intent account and its escrow token account; the rent of the wrapped SOL token account when it sells SOL, and of the receiver's token account, if they do not exist yet; the escrow; the create fee, which goes to the engine's fee recipient and does not come back; and the crank bounty, which the intent account holds. `cancel` returns the escrow to the owner's token account for the sold token, and `unwrap` returns the wrapped SOL account's balance and rent to the wallet. A fill or settle pays the escrow out as [Fees](#fees) describes. The intent account keeps its rent until someone closes it, and the bounty until someone expires or closes it; [Who can do what](#who-can-do-what) says who receives them. `settleProof`'s payer pays the rent of each token account it creates for the worker, the judge or the fee recipient. The SDK has no expire or close call: build them with `buildExpireIntent` and `buildCloseIntent` from `@intent-engine/core` and send them with `client.send`. `configSummary` gives the create fee and the crank bounty in lamports; this prints them in SOL.

```ts
const { createFee, crankBounty } = configSummary(await client.config());
console.log(formatAmount(createFee, sell.decimals), formatAmount(crankBounty, sell.decimals));
```

## Test offline

`svmTransport(svm)` from `@intent-engine/client/svm` runs the client against a local LiteSVM instance instead of a cluster: pass it as `createClient({ url, transport })`. It needs the `litesvm` package, which ships for Linux and macOS only; on Windows, run it in WSL.

## Next

- [Engine errors](reference/engine-errors.md)
- [Errors](reference/errors.md)
- [Run a solver](solver.md)
