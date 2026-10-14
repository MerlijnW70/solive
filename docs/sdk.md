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

`watch` calls back once after its first read with the current intents, even when it finds none, then with every intent that changed and with the last known state of each intent whose account closed, until its signal aborts. It rereads the chain every `resyncSeconds` (a client option, default `WATCH_WAIT_SECONDS`), so a dropped notification only delays a change, and it keeps going through failed reads; pass `onError` next to `owner` to hear about each one. A reread never goes back past the newest slot the watch has seen, so a lagging RPC node cannot report a live intent as closed. A filled intent's account is closed soon after the fill, so `intent` then returns `null`. This prints `Open` now and `Cancelled` once the cancel below lands.

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

## Limit orders and Dutch auctions

A `LimitOrder` sells `makeAmount` for at least `takeAmount`. A `DutchAuction` sells `amountIn` for at least `startOut` until `startTs`, after which its minimum falls in a straight line to `endOut` at `endTs`. A fill takes the whole escrow. `termsOf` prices an intent at the time you pass it; pass the chain's time from `chainTime`, since the chain's clock and yours can differ. `tokenName` returns `SOL` for `NATIVE_MINT`, `TEST` for `DEVNET_TEST_MINT` and `undefined` for any other mint.

`fillOf` reads what filled an intent from its history, also after its account closed, and returns `null` until a fill lands. A solver fills in one step, which the engine reports as `IntentFilled`, or in two, reported as `FillBegun` and `FillEnded`, as the devnet filler does. `fillOf` returns either as the `steps`, the `solver`, what it `delivered` to the owner, the minimum `required` at the fill, the protocol `fee` and the solver's `net` out of the escrow, with the `signature`, `slot` and `blockTime`, which is `null` when the cluster reports none. The devnet filler delivers the minimum it reads; an auction's minimum keeps falling, so by the time the fill lands the minimum can be below what the filler delivers.

Each order below sells 0.01 SOL, and the devnet filler fills both. The code waits for each fill, so run it while the filler is online. This prints each order's kind, the least it receives now and its token, then the steps of its fill, what it delivered and the minimum at the fill; for the limit order these are 2, 1.5 and 1.5.

```ts
import { setTimeout as sleep } from "node:timers/promises";
import { eventNamed, tokenName } from "@intent-engine/core";

const start = await client.chainTime();
const limit = { kind: Kind.LimitOrder, makeAmount: parseAmount("0.01", sell.decimals), takeAmount: parseAmount("1.5", buy.decimals) } as const;
const auction = { kind: Kind.DutchAuction, amountIn: limit.makeAmount, startOut: parseAmount("1.9", buy.decimals), endOut: parseAmount("1", buy.decimals), startTs: start, endTs: start + 600n } as const;
for (const params of [limit, auction]) {
  const placed = await client.createIntent({ ...order, params });
  const { intent } = (await client.intent(signer.address, placed.nonce))!;
  console.log(kindName(intent.kind), formatAmount(termsOf(intent, await client.chainTime()).receivesAtLeast ?? 0n, buy.decimals), tokenName(intent.outputMint));
  let fill = await client.fillOf(placed.intent);
  while (fill === null) {
    await sleep(2_000);
    fill = await client.fillOf(placed.intent);
  }
  console.log(fill.steps, formatAmount(fill.delivered, buy.decimals), formatAmount(fill.required, buy.decimals));
}
```

## Escrow work behind a proof

An `AttestedResult` intent holds payment until its attestor, the judge, signs a result. `specHash` pins the acceptance spec the judge checks, and `judgeFee` pays the judge out of the escrow; [Who can do what](#who-can-do-what) lists what each party may do. `settleProof` is the judge's call: it signs the result over the spec and pays the worker's wallet `payTo`, creating any token account the payout needs. It refuses, before sending, an expired escrow with `EscrowExpired`, a `payTo` owned by a program with `PayToNotWallet`, and a `payTo` whose token account for the mint it no longer holds with `PayeeMoved`. The judge pays the transaction unless `payer` names another signer; here your wallet pays, so the new judge key needs no SOL. In practice the judge runs this with its own key. `history` returns the engine events for one intent, newest first, each with its signature and slot, and keeps working after the account closes. A release event carries `deliveredSha256` when the release recorded the paid work's hash, in its own memo or in a follow-up transaction its judge signed. An `IntentAttested` event's `net` is what the payee received. This prints `Filled`, then `IntentAttested` and the worker's pay in SOL.

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
const paid = eventNamed(await client.history(job.intent), "IntentAttested");
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

## Expire and close

`expire` refunds an open intent at or after its expiry, and `close` returns the rent of a filled, cancelled or expired intent; [Who can do what](#who-can-do-what) says who receives what. Both take the wallet that signs, then the intent's owner and nonce. The devnet filler also expires and closes overdue intents, in passes with a pause between them, so on devnet an overdue intent closes soon after its expiry, often before you do. This creates a swap with a short expiry, waits until the chain's clock reaches it, expires and closes it, rethrowing a failed expire only while the intent is still open and a failed close only while it still exists, since the filler may have done either first, and prints `null`.

```ts
const due = (await client.chainTime()) + 10n;
const brief = await client.createIntent({ ...order, params: swap, expiresAt: due });
while ((await client.chainTime()) < due) {
  await sleep(1_000);
}
try {
  await client.expire(signer, signer.address, brief.nonce);
} catch (error) {
  if ((await client.intent(signer.address, brief.nonce))?.intent.status === IntentStatus.Open) {
    throw error;
  }
}
try {
  await client.close(signer, signer.address, brief.nonce);
} catch (error) {
  if ((await client.intent(signer.address, brief.nonce)) !== null) {
    throw error;
  }
}
console.log(await client.intent(signer.address, brief.nonce));
await client.unwrap(signer);
```

## Find work and deliver it

The chain holds only a proof escrow's spec hash. `specUrl` on `createIntent` publishes where the spec lives, in a memo the owner signs in the create transaction. `jobs` lists up to 50 open, unexpired proof escrows, those with the most time left first, optionally only those naming one `attestor`, each with its `specUrl`, which is `null` when none was published. `spec` fetches that url, following no redirect and reading at most 1048576 bytes, and refuses a plain http url on mainnet, devnet or testnet, and returns its `text`, its `sha256` and whether it `matches` the committed hash; it never runs the text. A worker announces its work with `deliver`: one transaction it signs, with a memo naming the intent, the work's sha256 and the url to fetch it from, and a transfer of 0 lamports to the judge, so the delivery shows in the judge's history. The judge reads them with `deliveries`, newest first, from its history back to the creation of the escrows it judges, at most 100 pages of 1000 transactions, and gets only memos that name one of its own open proof escrows, or the one of its proof escrows it asks for with `intent`. `deliveryRecord` returns the same `deliveries` with `complete` and the number of `pages` it read; pass `pages` to read further. `complete` is `true` only when the read reached a transaction older than the escrow, or reached the end of the history on a node whose ledger goes back to the escrow's creation; it is `false` when the history is longer than the pages it reads or the node has pruned the slots it would need. A transport you pass to `createClient` needs `signaturesOf`, `transactionsOf` and `firstAvailableSlot` for `deliveryRecord` to be complete. Without `signaturesOf` and `transactionsOf` it reads only the 100 most recent transactions, and without `firstAvailableSlot` it cannot tell that the node's ledger reaches back to the escrow's creation; more pages fix neither. `deliveries` is for listing; decide whom to pay only from a complete record. Here the spec is a file of this repository at a fixed commit, your wallet plays the worker, and the judge then releases the escrow to the earliest wallet that announced the hash it checked, recording that hash in the release. This prints `true true` twice.

```ts
import { firstDelivery } from "@intent-engine/client";

const specUrl = "https://raw.githubusercontent.com/MerlijnW70/solive/3aad6ee86067e10695d44e47fbc5ed67535a5cfb/SECURITY.md";
const spec = new Uint8Array(createHash("sha256").update(new Uint8Array(await (await fetch(specUrl)).arrayBuffer())).digest());
const posted = await client.createIntent({ ...order, params: { ...work, specHash: spec }, specUrl });
const listed = (await client.jobs({ attestor: judge.address })).find(({ intent }) => intent === posted.intent);
console.log(listed?.specUrl === specUrl, (await client.spec(posted.intent))?.matches);
const sha256 = createHash("sha256").update("the delivered work").digest("hex");
await client.deliver({ worker: signer, intent: posted.intent, sha256, url: "https://example.org/work.tar" });
const record = await client.deliveryRecord({ judge: judge.address, intent: posted.intent });
if (!record.complete) {
  throw new Error(`read ${record.pages} pages without reaching the escrow's creation; pass a higher pages`);
}
const delivery = firstDelivery(record.deliveries, sha256);
console.log(delivery?.worker === signer.address, delivery?.sha256 === sha256);
await client.settleProof({ judge, payer: signer, owner: signer.address, nonce: posted.nonce, payTo: delivery!.worker, result: 1n, deliveredSha256: sha256 });
await client.unwrap(signer);
```

Anyone can copy an announcement once it is on chain, so a judge pays the earliest announcer of the hash it checked: `firstDelivery(record.deliveries, sha256)` returns that announcement, or `null`. `settleProof` takes `deliveredSha256` to record the paid work's hash in the release, in the memo `intent-engine receipt` and `solive_wallet_receipt` read. [Judge a proof escrow](judge.md) does all of this from the command line.

## Who can do what

- Any wallet other than the owner and the receiver can fill an open swap intent before it expires.
- Only a verdict signed by the judge the intent names settles a proof escrow; any wallet can send that signed verdict and pay for it.
- A fill or settle at or after the expiry fails with `IntentExpired`; `settleProof` throws `EscrowExpired` before it sends.
- Only the owner can cancel; another wallet's cancel fails with `Unauthorized`.
- The owner can cancel an open proof escrow until the judge settles it, also after it expires as long as nobody has expired it.
- After a settle, the owner's cancel fails with `InvalidTransition`.
- After a cancel, the judge's settle fails: `settleProof` throws `NotSettleable` before it sends, and the engine refuses the same transaction with `InvalidTransition`.
- Anyone can expire an open intent at or after its expiry, which returns the escrow to the owner's token account and pays the expirer the crank bounty; before the expiry it fails with `NotExpired`.
- Anyone can close a filled, cancelled or expired intent, which returns the rent of the intent and its escrow account to the wallet that paid it, the owner for `createIntent`; the closer earns the crank bounty the intent still holds, except on a cancelled intent, where it goes to that wallet too.
- Closing an open intent fails with `InvalidTransition`.

## Costs

`createIntent` pays from the signer's wallet: on its first intent, the rent of its user state account, which stays open; the rent of the intent account and its escrow token account; the rent of the wrapped SOL token account when it sells SOL, and of the receiver's token account, if they do not exist yet; the escrow; the create fee, which goes to the engine's fee recipient and does not come back; and the crank bounty, which the intent account holds. `cancel` returns the escrow to the owner's token account for the sold token, and `unwrap` returns the wrapped SOL account's balance and rent to the wallet. A fill or settle pays the escrow out as [Fees](#fees) describes. The intent account keeps its rent until someone closes it, and the bounty until someone expires or closes it; [Who can do what](#who-can-do-what) says who receives them. `settleProof`'s payer pays the rent of each token account it creates for the worker, the judge or the fee recipient. `expire` pays the rent of the owner's token account for the sold token when it has to create one. `configSummary` gives the create fee and the crank bounty in lamports; this prints them in SOL.

```ts
const { createFee, crankBounty } = configSummary(await client.config());
console.log(formatAmount(createFee, sell.decimals), formatAmount(crankBounty, sell.decimals));
```

## Test offline

`svmTransport(svm)` from `@intent-engine/client/svm` runs the client against a local LiteSVM instance instead of a cluster: pass it as `createClient({ url, transport })`. It needs the `litesvm` package, which ships for Linux and macOS only; on Windows, run it in WSL.

## Next

- [Judge a proof escrow](judge.md)
- [Engine errors](reference/engine-errors.md)
- [Errors](reference/errors.md)
- [Run a solver](solver.md)
