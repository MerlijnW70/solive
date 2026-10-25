# The full client

Every option of every call, in base units. Start with [Build in TypeScript](sdk.md): this page continues its program.

## Connect

`solive.client` is the full client underneath `connect`. `createClient` makes one on its own. In Node, import it from `@intent-engine/client/node`, as here, so spec fetches keep their address checks.

```ts
import { createClient } from "@intent-engine/client/node";

const client = createClient({ url: "https://api.devnet.solana.com" });
```

## Create a swap intent

Sell 0.05 SOL for at least 50 test tokens. The devnet filler prices test tokens at 200 per wrapped SOL and pays exactly the minimum asked; 50 is more than 0.05 SOL buys at that price, so the intent stays open until you cancel it.

`createIntent` sets up what it needs in the same transaction: it registers the wallet, wraps the SOL and creates the receiving token account. It picks the next free nonce and expires the intent in an hour, unless you pass `nonce`, `expiresIn` or `expiresAt`.

`swapExactIn`, `limitOrder`, `dutchAuction` and `attestedResult` build the params of each kind.

```ts
import { DEVNET_TEST_MINT, NATIVE_MINT, parseAmount, swapExactIn } from "@intent-engine/core";

const sell = await client.mint(NATIVE_MINT);
const buy = await client.mint(DEVNET_TEST_MINT);
const order = { signer, inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT };
const swap = swapExactIn({ amountIn: parseAmount("0.05", sell.decimals), minOut: parseAmount("50", buy.decimals) });
const { nonce } = await client.createIntent({ ...order, params: swap });
```

## Read

- `intents` returns the intents that match every field its filter gives of `owner`, `status`, `kind`, `inputMint`, `outputMint` and `attestor`; the node applies the filter.
- `intents`, `jobs`, `announcementsTo` and `announcementsBy` skip an account of a layout this SDK cannot read and name it in `unreadable`, with the `address` and the `reason`; any other failed read still throws.
- `intent` returns one intent, or `null` once it is closed.
- `configSummary` spells out the engine's settings: pauses, which kinds are on, and their fees.
- `kindName`, `statusName` and `termsOf` name an intent's kind and status and decode its terms.

This prints `SwapExactIn Open` and then the terms in tokens.

```ts
import { configSummary, formatAmount, IntentStatus, kindName, statusName, termsOf } from "@intent-engine/core";

const { createPaused, fillPaused, kinds } = configSummary(await client.config());
console.log(createPaused, fillPaused, kinds.map(({ name, create, fill, feeBps }) => `${name} ${create} ${fill} ${feeBps}`));
const { intents: mine } = await client.intents({ owner: signer.address });
for (const { intent } of mine.filter(({ intent }) => intent.nonce === nonce)) {
  const { sells, receivesAtLeast } = termsOf(intent);
  console.log(kindName(intent.kind), statusName(intent.status));
  console.log(formatAmount(sells, sell.decimals), formatAmount(receivesAtLeast ?? 0n, buy.decimals));
}
```

## Watch

`watch` calls back with the current intents, then with every intent that changes, until its signal aborts. Each intent it reports carries the `slot` the node read it at, and the watch never reports a state of an intent older than one it already reported. With notifications the watch rereads the chain every `resyncSeconds` and at once after the notification stream reconnects; without notifications it rereads every `pollMs`.

The callback's second argument, `closed`, holds the last state the watch saw of each intent before its account closed. Pass `onError` to hear about failed reads, accounts the watch cannot read and errors the callback throws; the watch skips each and goes on. A filled intent's account closes soon after the fill, so `intent` then returns `null`. This prints `Open` now and `Cancelled` once the cancel below lands.

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
await client.cancel(signer, { owner: signer.address, nonce });
await watched;
await client.unwrap(signer);
```

## Limit orders and Dutch auctions

A `LimitOrder` sells `makeAmount` for at least `takeAmount`. A `DutchAuction` sells `amountIn` for at least `startOut` until `startTs`, after which its minimum falls in a straight line to `endOut` at `endTs`. A fill takes the whole escrow. `termsOf` prices an intent at the time you pass it; pass the chain's time from `chainTime`, since the chain's clock and yours can differ. `tokenName` returns `SOL` for `NATIVE_MINT`, `TEST` for `DEVNET_TEST_MINT` and `undefined` for any other mint.

`fillOf` reads how an intent was filled, also after its account closed, or returns `null` before a fill. It returns the `steps`, the `solver`, what it `delivered`, the minimum `required`, the protocol `fee` and the solver's `net`, with the `signature`, `slot` and `blockTime`. An auction's minimum keeps falling, so it can end below what the filler delivered.

Each order below sells 0.01 SOL, and the devnet filler fills both. The code waits for each fill, so run it while the filler is online. This prints each order's kind, the least it receives now and its token, then the steps of its fill, what it delivered and the minimum at the fill; for the limit order these are 2, 1.5 and 1.5.

```ts
import { setTimeout as sleep } from "node:timers/promises";
import { dutchAuction, eventNamed, limitOrder, tokenName } from "@intent-engine/core";

const start = await client.chainTime();
const limit = limitOrder({ makeAmount: parseAmount("0.01", sell.decimals), takeAmount: parseAmount("1.5", buy.decimals) });
const auction = dutchAuction({ amountIn: limit.makeAmount, startOut: parseAmount("1.9", buy.decimals), endOut: parseAmount("1", buy.decimals), startTs: start, endTs: start + 600n });
for (const params of [limit, auction]) {
  const placed = await client.createIntent({ ...order, params });
  const { intent } = (await client.intent(placed.intent))!;
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

An `AttestedResult` intent holds payment until its judge signs a result. `specHash` pins the spec the judge checks, and `judgeFee` pays the judge out of the escrow.

A worker announces its work with `announce`. `settleProof` is the judge's call: it pays the worker that made the announcement it names, given its opening, the work's sha256 and the announcement's salt. Before sending, it refuses an expired escrow (`EscrowExpired`), a worker owned by a program (`PayToNotWallet`), a worker whose token account moved (`PayeeMoved`), an opening that does not open the announcement (`NotSettleable`) and an escrow another worker has claimed (`ClaimHeldBy`).

Here your wallet pays for the worker's announcement and for the release, so neither new key needs SOL. The judge keeps its 64 key bytes, because it opens what workers seal to it.

`history` returns a page of an intent's `events`, newest first, also after it closes, and `next`: pass it as `before` for the next older page, until it is `null`. An `IntentAttested` event's `net` is what the payee received. This prints `Filled`, then `IntentAttested` and the worker's pay in SOL.

```ts
import { generateKeyPairSync } from "node:crypto";
import { attestedResult } from "@intent-engine/core";

const judgeJwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
const judgeKeypair = Uint8Array.from([...Buffer.from(judgeJwk.d ?? "", "base64url"), ...Buffer.from(judgeJwk.x ?? "", "base64url")]);
const judge = await createKeyPairSignerFromBytes(judgeKeypair);
const worker = await generateKeyPairSigner();
const specHash = new Uint8Array(createHash("sha256").update("the acceptance spec the work must pass").digest());
const pay = parseAmount("0.01", sell.decimals);
const work = attestedResult({ amountIn: pay, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash, judgeFee: pay / 10n });
const job = await client.createIntent({ ...order, params: work });
const workSha256 = createHash("sha256").update("the work behind the proof").digest("hex");
const made = await client.announce({ worker, payer: signer, intent: job.intent, sha256: workSha256, url: "https://example.org/proof.tar" });
const opening = { sha256: workSha256, salt: made.salt };
await client.settleProof({ judge, payer: signer, intent: job.intent, announcement: made.announcement, opening, result: 1n });
console.log(statusName((await client.intent(job.intent))?.intent.status ?? -1));
const paid = eventNamed((await client.history(job.intent)).events, "IntentAttested");
console.log(paid?.name);
console.log(formatAmount(paid?.fields.net ?? 0n, sell.decimals));
```

## Fees

- Each kind has a protocol fee, `feeBps` in `configSummary`, taken from the escrow at the fill.
- An intent records its kind's fee and the partner cut, `feeBps` and `partnerCutBps`, when it is created, and every fill or release pays those. A later config change applies only to intents created after it.
- The engine caps it at `MAX_FEE_BPS` (100) for swap, limit and dutch orders and at `MAX_ATTESTED_FEE_BPS` (300) for attested ones; `maxFeeBpsFor` gives a kind's cap.
- A proof escrow pays the judge's `judgeFee` first. The protocol fee and any partner fee come out of the rest, and the worker gets what remains.
- The protocol keeps the intent's `partnerCutBps` of every partner fee.
- `splitFees` and `feeBpsFor` from `@intent-engine/core` compute the same split.

This prints what the worker, the judge and the protocol received, in SOL; together they make up the escrow.

```ts
const received = [paid?.fields.net ?? 0n, work.judgeFee, paid?.fields.fee ?? 0n];
console.log(received.map((amount) => formatAmount(amount, sell.decimals)).join(" "));
```

## What a release moves

- A release of a proof escrow in SOL pays the worker and the judge in wrapped SOL, into their token accounts for `NATIVE_MINT`; `unwrap` closes that account and returns its balance and its rent to the wallet as SOL.
- `announce` takes the announcement's rent from the worker's own wallet, and on the first announcement to an escrow the delivery book's rent too, unless `payer` names another wallet to pay them.
- `reclaim` returns an announcement's rent to whoever paid it, for an unpaid one once the escrow is no longer open and for the paid one 30 days after the release; `closeBook` then returns the delivery book's rent to whoever paid it.
- After a release the intent reads `Filled`, and `escrowed` and `filled` both read the amount escrowed at create; the `net` of its `IntentAttested` event is what the worker received.

## Held split shares

A split release pays every co-author whose canonical token account takes the payout. When a co-author's account cannot take it, because it requires memos, is frozen, is closed or has another blocking setting, the release still pays everyone else and holds that co-author's share in the escrow's vault for it to claim.

- `heldShares(wallet)` lists the shares held for a wallet, each with its `intent`, `announcement`, `index`, `amount`, `mint`, the `account` the release could not pay, the `release` signature and the `split` a claim names. It takes the split from the release transaction the program executed and leaves out a share once the announcement's `held` byte shows it claimed.
- `claimHeld({ wallet, announcement, to })` pays a held share into `to`, any token account the wallet owns for the escrow's token. Without `to` it pays the canonical account, only when that account takes the payout now, and throws `InvalidInput` otherwise; `plan.claimHeld` returns the plan with its `share` and `to`. A share that is not held throws `NoHeldShare`.
- A receipt lists held shares in `held`, paid to the co-author and `received` only once claimed, and the fees a release withheld because their account could not take them, the protocol fee among them, in `withheld` with their `role`. `reputation` counts a held share in `earned`, names it in the record's `held` and sums the unclaimed part per mint in `held`.
- The escrow cannot close, and fails with `SharesHeld`, until every held share is claimed or a year after it expires, when what is left returns to the owner; its paid announcement stays until the share is claimed.

## When the judge refuses

The engine has no refusal call: a judge that rejects the work sends nothing, and the escrow stays open. The owner cancels it. If the owner does not, anyone can expire the intent once its expiry passes, which returns the escrow to the owner's token account. After the cancel, `settleProof` throws `NotSettleable`. This prints `Cancelled NotSettleable`.

```ts
const refused = await client.createIntent({ ...order, params: work });
await client.cancel(signer, refused.intent);
const late = await client.settleProof({ judge, payer: signer, intent: refused.intent, announcement: made.announcement, opening, result: 1n }).catch((error: unknown) => error);
console.log(statusName((await client.intent(refused.intent))?.intent.status ?? -1), (late as Error).name);
await client.unwrap(signer);
```

## Expire and close

`expire` refunds an open intent once it has expired, and `close` returns the rent of a finished intent. Both take the signer, then the intent. The devnet filler also expires and closes overdue intents, in passes with a pause between them, so it may get there first; the code below allows for that. This prints `null`.

```ts
const due = (await client.chainTime()) + 10n;
const brief = await client.createIntent({ ...order, params: swap, expiresAt: due });
while ((await client.chainTime()) < due) {
  await sleep(1_000);
}
try {
  await client.expire(signer, brief.intent);
} catch (error) {
  if ((await client.intent(brief.intent))?.intent.status === IntentStatus.Open) {
    throw error;
  }
}
try {
  await client.close(signer, brief.intent);
} catch (error) {
  if ((await client.intent(brief.intent)) !== null) {
    throw error;
  }
}
console.log(await client.intent(brief.intent));
await client.unwrap(signer);
```

## Find work and deliver it

- `specUrl` on `createIntent` publishes where the spec lives, in a memo the owner signs.
- `jobs` lists up to 50 open, unexpired proof escrows, those with the most time left first, each with its `specUrl`, its `judgeFee` and its `net`: what the worker receives if paid now, after the judge fee, the protocol fee and any partner fee, as a release splits them, or `null` while the engine could not release it.
- `jobs` keeps only the escrows that match every field its filter gives of `attestor`, `mint`, `minSells`, `owner`, `excludeOwners` and `unclaimed`.
- `spec` fetches that url, following no redirect and reading at most 1048576 bytes, and says whether it `matches` the committed hash. It never runs the text.
- `spec` refuses a url whose host resolves to a private, link-local or loopback address on every cluster, allowing loopback only when the RPC url is loopback or the transport is `offline`, as a test world's is, and reads only a spec memo the escrow's owner signed. Without the Node entry it checks less, as [In a browser](#in-a-browser) says.
- A `fetch` you pass to `createClient` is handed the checked `addresses` of the host whenever the client checked them, and must connect only to them.
- `announce` records a worker's delivery on chain: an announcement account with a commitment that binds the work's sha256 to the worker's wallet and a salt, and the salt and url sealed to the judge's published encryption key, to the key derived from its wallet when it publishes none, or to each committee member's key.
- `announce` syncs a committee's keys first when its snapshot does not match its members' published keys, and announcing the same work and url again returns the same announcement without sending.
- The salt and the sealing keys come from the worker's own signature over the intent and the sha256, so only its key derives them. `announce` refuses a signer that cannot sign messages, such as a Ledger, with `NoMessageSigner`; such a worker passes `secret`, 32 bytes of its own that it keeps, or `saltSignature`, a signature made elsewhere, which must verify for the worker (`BadSaltSignature`).
- `announce` refuses a url longer than its transaction can carry with `UrlTooLong` before sending.
- `announcements` lists an escrow's announcements in seq order from accounts alone, never from transaction history, and says whether the list is `complete`: the escrow is open and every seq from 1 to one below its delivery book's `nextSeq` is present exactly once. An open escrow nobody has announced to yet has no book and lists complete and empty. Once the escrow is no longer open, the list says `closed` and is never complete.
- An announcement of the escrow that this SDK cannot read is named in `unreadable` and keeps the list incomplete.
- `firstOpening` returns the first announcement that opens to the checked sha256 with the keys it is given, and refuses with `FirstOpeningRefused` while the list is incomplete, an earlier announcement is sealed to a key it was not given, or another worker holds the claim.
- `firstOpening` passes over an earlier announcement that is not a delivery and lists it in `skipped` with its reason, for a judge and for each committee member alike: one sealed to a key it was given that does not open with it (`does-not-open`), one whose wallet slot names a key other than the one derived from the wallet the program assigns to that slot (`forged-wallet-slot`), and one sealed to more or fewer recipients than the committee has members (`wrong-recipient-count`).
- `openings` walks the announcements as `firstOpening` does, with the same completeness rule, skips and refusals for keys, but needs no sha256: its `opening` is the earliest announcement that opens with the keys given, with its `announcement`, `seq`, `worker`, `salt` and work `url`, or `null` while none does, and `skipped` lists those it passed over. A judge fetches that url, hashes the work, and passes the sha256 to `firstOpening` and `settleProof`.
- A transport you pass to `createClient` needs `engineAccounts` to list announcements.

Here your wallet plays the worker, and the judge pays the first announcement that opens to the hash it checked. This prints `true true` twice.

```ts
const specUrl = "https://raw.githubusercontent.com/MerlijnW70/solive/3aad6ee86067e10695d44e47fbc5ed67535a5cfb/SECURITY.md";
const spec = new Uint8Array(createHash("sha256").update(new Uint8Array(await (await fetch(specUrl)).arrayBuffer())).digest());
const posted = await client.createIntent({ ...order, params: { ...work, specHash: spec }, specUrl });
const listed = (await client.jobs({ attestor: judge.address })).jobs.find(({ intent }) => intent === posted.intent);
console.log(listed?.specUrl === specUrl, (await client.spec(posted.intent))?.matches);
const sha256 = createHash("sha256").update("the delivered work").digest("hex");
await client.announce({ worker: signer, intent: posted.intent, sha256, url: "https://example.org/work.tar" });
const first = await client.firstOpening({ intent: posted.intent, sha256, keypair: judgeKeypair });
console.log(first.worker === signer.address, first.sha256 === sha256);
await client.settleProof({ judge, payer: signer, intent: posted.intent, announcement: first.announcement, opening: first, result: 1n });
await client.unwrap(signer);
```

`settleProof`, `settleCommittee` and `settleSplit` sign over the announcement and its opening and pay the announcing worker's token account; any wallet can send the signed release. `history` reads the paid work's sha256 and salt from the release itself.

`refute` lets an earlier worker record on chain that a later announcement of the same work was paid, `reclaim` closes every announcement of a worker that the program lets close now and that cannot still refute a release, rent back to whoever paid it, and says in `reasons` why each one in `kept` stays, and `closeBook` closes an escrow's empty delivery book. [Judge work](judge.md) does all of this from the command line.

## Standing

`reputation` reads what a worker did and was paid for from the chain alone.

- `reputation` finds a worker's announcements in the `DeliveryAnnounced` events of its own signed transactions and reads each release from the history of the announcement it paid, so a paid record stays after its announcement account closes.
- A wallet counts as a co-author only when a split release names it as a payee; its record names the paid announcement and the role `co-author`, and announcing on the escrow alone credits nothing.
- A refutation counts against every wallet the release paid, announcer and split co-authors alike, only when the earlier announcement's stored blob opens under the revealed ephemeral key, at every slot, to the paid work (`substantiated`); `unsubstantiated` refutations and `unverifiable` ones, whose recipients' keys can no longer be known, are listed on the record and not counted.
- `complete` is false, with a `reason`, whenever a page limit or an unreadable account cut the record short.
- A refutation or announcement of a layout this SDK cannot read is named in `unreadable`, on the reputation and on its record, and that record is left out of the totals.
- `trustOf` adds an edge from a payer to a worker only for a paid record whose release the reputation read verified, and never for a self-dealt one.

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

`createIntent` pays from the signer's wallet:

- the rent of its user account, once, which stays open;
- the rent of the intent and its escrow account, and of any token account it creates;
- the escrow itself;
- the create fee, which does not come back;
- the crank bounty, which the intent holds until someone expires or closes it.

`cancel` returns the escrow, `close` returns the rent, and `unwrap` turns wrapped SOL back into SOL. This prints the create fee and the crank bounty in SOL.

```ts
const { createFee, crankBounty } = configSummary(await client.config());
console.log(formatAmount(createFee, sell.decimals), formatAmount(crankBounty, sell.decimals));
```

## Testing

`createTestWorld` from `@intent-engine/client/testing` starts the engine in LiteSVM, configured with devnet's fees and kinds, and returns a `client` on it. The package ships the program deployed on devnet, so it needs no build and reaches no network. `wallet` funds a new signer, `mint` and `tokens` make SPL tokens, `now` reads the clock the engine reads and `warp` moves it.

It needs the `litesvm` package, an optional peer of the client that npm does not install for you, which ships for Linux and macOS only; on Windows, run it in WSL.

```sh
npm install --save-dev litesvm@^1.5.0
```

- The world's transport is `offline`, so its clients create, announce and fetch plain-http loopback urls, such as a local server's; a client on a real cluster still refuses them.
- Its options are `start`, the clock's first unix time; `fees`, which replace devnet's; `program`, other program bytes; `domain`, the 32 bytes it reports as the genesis hash and sets as the engine's domain, devnet's by default; `url`, the RPC url its client reports, devnet's by default, which it never reaches; `devnetMints: false`, which leaves out the wrapped SOL and test mints; and `hooks` and `debug`, as in [Observe](#observe).

`svmTransport(svm)` from `@intent-engine/client/svm` runs the client against a LiteSVM instance of your own: pass it as `createClient({ url, transport })`.

This creates a proof escrow of 0.5 SOL, announces work from a worker and releases it. The worker's pay, after devnet's 3% fee on proof escrows, prints `0.485`.

```ts
import { createHash } from "node:crypto";
import { attestedResult, DEVNET_TEST_MINT, formatAmount, NATIVE_MINT, parseAmount } from "@intent-engine/core";
import { createTestWorld } from "@intent-engine/client/testing";

const world = await createTestWorld();
const [owner, judge, worker] = [await world.wallet(), await world.wallet(), await world.wallet()];
const specHash = new Uint8Array(createHash("sha256").update("the spec").digest());
const params = attestedResult({ amountIn: parseAmount("0.5", 9), minResult: 1n, maxResult: 1n, attestor: judge.address, specHash, judgeFee: 0n });
const job = await world.client.createIntent({ signer: owner, inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT, params });
const sha256 = createHash("sha256").update("the work").digest("hex");
await world.client.announce({ worker, intent: job.intent, sha256, url: "https://example.org/work.tar" });
const first = await world.client.firstOpening({ intent: job.intent, sha256, keypair: judge.keypair });
await world.client.settleProof({ judge, intent: job.intent, announcement: first.announcement, opening: first, result: 1n });
console.log(formatAmount(await world.tokenBalance(worker.address, NATIVE_MINT), 9));
```

This posts a proof escrow whose spec a local server holds, finds it with `jobs`, reads it with `spec` and delivers from a worker. The judge holds only its key: it takes the work url from `openings`, fetches and checks the work, and releases it with `settleProof`. This prints `true 0.4753`, the spec's match and the `net` that `jobs` gives, and then prints `0.4753`, what the worker received.

```ts
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { attestedResult, DEVNET_TEST_MINT, formatAmount, NATIVE_MINT, parseAmount } from "@intent-engine/core";
import { createTestWorld } from "@intent-engine/client/testing";

const files: Record<string, string> = { "/spec.md": "Deliver a line of text about rain.\n", "/work.txt": "rain on the tin roof\n" };
const server = createServer((request, response) => {
  const body = files[request.url ?? ""];
  response.writeHead(body === undefined ? 404 : 200).end(body);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const local = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const world = await createTestWorld();
const [owner, judge, worker] = [await world.wallet(), await world.wallet(), await world.wallet()];
const specHash = Uint8Array.from(Buffer.from(sha256(files["/spec.md"] ?? ""), "hex"));
const params = attestedResult({ amountIn: parseAmount("0.5", 9), minResult: 1n, maxResult: 1n, attestor: judge.address, specHash, judgeFee: parseAmount("0.01", 9) });
await world.client.createIntent({ signer: owner, inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT, params, specUrl: local + "/spec.md" });

const { jobs: [job] } = await world.client.jobs({ attestor: judge.address });
if (job === undefined) throw new Error("no job listed");
const spec = await world.client.spec(job.intent);
console.log(spec?.matches, formatAmount(job.net ?? 0n, 9));
await world.client.announce({ worker, intent: job.intent, sha256: sha256(files["/work.txt"] ?? ""), url: local + "/work.txt" });

const { opening } = await world.client.openings({ intent: job.intent, keypair: judge.keypair });
if (opening?.url == null) throw new Error("no delivery opens yet");
const work = new Uint8Array(await (await fetch(opening.url)).arrayBuffer());
if (!new TextDecoder().decode(work).includes("rain")) throw new Error("the work fails the spec");
const first = await world.client.firstOpening({ intent: job.intent, sha256: sha256(work), keypair: judge.keypair });
await world.client.settleProof({ judge, intent: job.intent, announcement: first.announcement, opening: first, result: 1n });
console.log(formatAmount(await world.tokenBalance(worker.address, NATIVE_MINT), 9));
server.close();
```

## Plan, sign and send yourself

`client.plan` builds what each write sends and sends nothing, for an app that signs through a wallet adapter, a multisig or a bundle service.

- `client.plan` has one method per write: `createIntent`, `cancel`, `fill`, `expire`, `close`, `settleProof`, `settleCommittee`, `settleSplit`, `claimHeld`, `announce`, `refute`, `reclaim`, `closeBook`, `feedback`, `createCommittee` and `unwrap`.
- A plan names the `payer`, the `setup` instructions that land first, the `instructions`, the signers each one needs in `setupSigners` and `signers`, and the `lookupTables` it relies on, which are none.
- `setupSigners` and `signers` list, for each instruction, the wallets that must sign the transaction that carries it, the `payer` among them whenever an instruction needs its signature; the `payer` also signs each transaction as its fee payer, and `settleProof` lists no judge, whose verdict travels as a signed message.
- `plan.createIntent` returns a `CreateIntentPlan`: a `Plan` that also names the `intent`, its `nonce`, `expiresAt` and `payTo`.
- A wallet that gives only its address plans with kit's `createNoopSigner(address)`: compile each part with that address as fee payer, have the wallet sign the compiled transaction, and send it.
- Each write sends its own plan, `setup` first, and refuses a signer that is not the plan's `payer`.
- `reclaim` splits its instructions into `batches`, one transaction each. A plan with no instructions sends nothing: `unwrap` with nothing wrapped, `createCommittee` for a committee that exists, `announce` for an announcement made before.
- Every call that names one intent takes its address or `{ owner, nonce }`.
- `createIntent` takes `partner` with `partnerBps`, from 1 to 100, a partner fee each fill pays, and `payTo`, the wallet that receives what a swap, limit order or auction buys; a proof escrow takes no `payTo`.
- `amount` turns decimal text into base units at the mint's decimals and refuses a negative, a non-number or too many decimals with `InvalidInput`; `format` turns base units back into text.

This plans a proof escrow of 0.5 SOL in the test world for a wallet known only by its address, compiles each part with `@solana/kit`, has the wallet sign it and sends it through the world's transport, then reads it back. Here `signTransaction` with the wallet's key pair stands in for the wallet adapter. On a cluster, send the signed transaction with your own RPC, such as kit's `sendAndConfirmTransactionFactory`. This prints `Open 0.5`.

```ts
import { createHash } from "node:crypto";
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
} from "@solana/kit";
import { attestedResult, DEVNET_TEST_MINT, NATIVE_MINT, statusName } from "@intent-engine/core";
import { createTestWorld } from "@intent-engine/client/testing";

const world = await createTestWorld();
const [wallet, judge] = [await world.wallet(), await world.wallet()];
const specHash = new Uint8Array(createHash("sha256").update("the spec").digest());
const amountIn = await world.client.amount(NATIVE_MINT, "0.5");
const params = attestedResult({ amountIn, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash, judgeFee: 0n });
const plan = await world.client.plan.createIntent({ signer: createNoopSigner(wallet.address), inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT, params });
for (const instructions of [plan.setup, plan.instructions].filter((part) => part.length > 0)) {
  const latest = await world.transport.latestBlockhash();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(plan.payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransaction([wallet.keyPair], compileTransaction(message));
  await world.transport.sendWire(getBase64EncodedWireTransaction(signed), latest);
}
const held = await world.client.intent(plan.intent);
console.log(statusName(held?.intent.status ?? -1), await world.client.format(NATIVE_MINT, held?.intent.escrowed ?? 0n));
```

## Observe

`hooks` on `createClient` shows what the client does on the wire. Each hook gets one plain object.

- `request` and `response` fire for every RPC call with its `method`, an `id` the pair shares and the `attempt`; `response` adds the `ms` it took and, when it failed, the `error`.
- `retry` fires each time the client retries a rate-limited or lagging call, with the `method`, the `attempt`, the `delay` and the `reason`.
- `send` fires when a transaction leaves the client, with its `signature`, `payer`, `instructions` count and `lastValidBlockHeight`; `confirm` fires when it confirms, fails or expires, with the `outcome`, the `slot` when known and the `ms` since `send`.
- `fetch` fires for every spec url the client fetches, with the url, the `status` and the `ms`.
- A hook that throws or rejects changes nothing the client does; `hooks.error` receives each such error.
- A url in a hook or log line shows only its scheme, host and port, and no event holds a key, a secret, a salt signature or a decrypted url.
- `debug: true` writes one line per event to `console.debug`, and a function given as `debug` receives each line instead.
- `createTestWorld` takes the same `hooks` and `debug`, and the CLI and MCP server take `--debug`, which writes the lines to stderr.

This creates a proof escrow in a test world, counting RPC calls, and prints `send 7`, `confirm confirmed` and `true`.

```ts
import { createHash } from "node:crypto";
import { attestedResult, DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { createTestWorld } from "@intent-engine/client/testing";

let calls = 0;
const world = await createTestWorld({
  hooks: {
    request: () => {
      calls += 1;
    },
    send: ({ instructions }) => console.log(`send ${instructions}`),
    confirm: ({ outcome }) => console.log(`confirm ${outcome}`),
  },
});
const [owner, judge] = [await world.wallet(), await world.wallet()];
const specHash = new Uint8Array(createHash("sha256").update("the spec").digest());
const params = attestedResult({ amountIn: await world.client.amount(NATIVE_MINT, "0.5"), minResult: 1n, maxResult: 1n, attestor: judge.address, specHash, judgeFee: 0n });
await world.client.createIntent({ signer: owner, inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT, params });
console.log(calls > 0);
```

## In a browser

The roots of `@intent-engine/core` and `@intent-engine/client` import no Node module, so a bundler builds them for the browser without polyfills, and an app that imports one helper bundles only that helper and what it uses.

- `createClient` and `connect` run in a page that offers only `fetch`, `crypto`, `TextEncoder`, `TextDecoder`, `URL` and `console`.
- `createClient` and `connect` from `@intent-engine/client/node` check every address a spec host resolves to and connect only to those; the Node entry also holds Ledger signing, `ledgerSigner` and `openUsb`.
- `@intent-engine/client/svm` and `@intent-engine/client/testing` run in Node only.
- Without the Node entry, `spec` fetches with the global `fetch`, follows no redirect and reads at most 1048576 bytes.
- It refuses a url whose host is written as a private, link-local or loopback address, or is a `localhost` name, unless the RPC url is loopback or the transport is `offline`; it cannot check where a host name resolves.
- A page hashes a spec with web crypto: `new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))` is the 32-byte `specHash` of the spec `text`.
- Pass `lookup`, a function from a host name to its addresses, to check them all; the `fetch` you pass then receives the checked `addresses`.
- `@intent-engine/client/internal` and `@intent-engine/core/internal` hold what the CLI, the solver and the tests share; they carry no stability promise and change in any release.

## Next

- [Judge work](judge.md)
- [Engine errors](reference/engine-errors.md)
- [Errors](reference/errors.md)
- [Run a solver](solver.md)
