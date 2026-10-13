# Build on the engine from TypeScript

Create, watch, cancel and settle intents from your own code with the npm packages. This page runs on devnet: devnet SOL and the test token have no value, and the program has not had an external audit. CI runs every TypeScript block on this page, in order, as one program.

## Install

Node.js 22.12 or later.

```sh
npm install @intent-engine/core @intent-engine/client @solana/kit
```

Paste the TypeScript blocks below, in order, into one file `main.mts` and run it with `node --experimental-strip-types main.mts`. Later blocks use names earlier blocks define.

## Connect

The code pays from a devnet wallet that holds devnet SOL, wrapped SOL and a test token account. Make one with the Solana CLI:

```sh
solana-keygen new --no-bip39-passphrase -o ~/solive-wallet.json
solana config set --url devnet --keypair ~/solive-wallet.json
solana airdrop 1
spl-token wrap 0.2
spl-token create-account ETU8trkkfE8gNVPDGbCaJUoH88wy6yYV6ttJdc9NKB88
```

```ts
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { address, createKeyPairSignerFromBytes } from "@solana/kit";
import { createClient } from "@intent-engine/client";

const client = createClient({ url: "https://api.devnet.solana.com" });
const signer = await createKeyPairSignerFromBytes(
  new Uint8Array(JSON.parse(await readFile(`${homedir()}/solive-wallet.json`, "utf8"))),
);
const WSOL = address("So11111111111111111111111111111111111111112");
const TEST = address("ETU8trkkfE8gNVPDGbCaJUoH88wy6yYV6ttJdc9NKB88");
```

## Read

`config()` returns the engine's settings, `intents({ owner })` every intent a wallet made and `intent(owner, nonce)` one intent, or `null` if that nonce holds none.

```ts
import { IntentStatus } from "@intent-engine/core";

const statusOf = (status: number) =>
  Object.keys(IntentStatus).find((name) => IntentStatus[name as keyof typeof IntentStatus] === status);

const config = await client.config();
const mine = await client.intents({ owner: signer.address });
const first = await client.intent(signer.address, 0n);
console.log(config.feeBps, mine.map(({ intent }) => statusOf(intent.status)), first?.address);
```

## Create a swap intent

Sell 0.05 wrapped SOL for at least 50 test tokens, more than the devnet filler pays, so the intent stays open until you cancel it. A wallet's first intent also registers the wallet with `buildInitUser`.

```ts
import { buildCreateIntent, buildInitUser, Kind, parseAmount } from "@intent-engine/core";
import { chainTime, loadUser, mintOf } from "@intent-engine/client";

const sell = await mintOf(client.transport, WSOL);
const buy = await mintOf(client.transport, TEST);
const register = (await loadUser(client.transport, signer.address)) === null ? [await buildInitUser({ owner: signer })] : [];
const order = {
  owner: signer,
  treasury: config.feeRecipient,
  maxCreateFee: config.createFee,
  maxBounty: config.crankBounty,
  expiresAt: (await chainTime(client.transport)) + 3_600n,
  inputMint: WSOL,
  outputMint: TEST,
  inputTokenProgram: sell.tokenProgram,
  outputTokenProgram: buy.tokenProgram,
};
const swap = { kind: Kind.SwapExactIn, amountIn: parseAmount("0.05", sell.decimals), minOut: parseAmount("50", buy.decimals) } as const;
const nonce = await client.nextNonce(signer.address);
await client.send([...register, await buildCreateIntent({ ...order, nonce, params: swap })], signer);
```

## Watch

`watch` calls back with every intent that changed, first with the current ones, until its signal aborts. This prints `Open` now and `Cancelled` once the cancel below lands.

```ts
const controller = new AbortController();
const watched = client.watch(
  (changed) => {
    for (const { intent } of changed) {
      if (intent.nonce === nonce) {
        console.log(statusOf(intent.status));
        if (intent.status !== IntentStatus.Open) {
          controller.abort();
        }
      }
    }
  },
  controller.signal,
  { owner: signer.address },
);
```

## Errors

A failed `send` throws. `explain` names the engine error behind it, or returns `null` if the engine raised none. An expiry in the past prints `ExpiryNotInFuture`.

```ts
const failure = await client
  .send([await buildCreateIntent({ ...order, nonce: nonce + 1n, expiresAt: 0n, params: swap })], signer)
  .catch((error: unknown) => error);
console.log(client.explain(failure)?.name);
```

## Cancel

Cancelling returns the escrow to your wrapped SOL token account.

```ts
import { buildCancelIntent } from "@intent-engine/core";

await client.send([await buildCancelIntent({ owner: signer, nonce, inputMint: WSOL, tokenProgram: sell.tokenProgram })], signer);
await watched;
```

## Escrow work behind a proof

An `AttestedResult` intent holds payment until its attestor, the judge, signs a result. `specHash` pins the acceptance spec the judge checks, and `judgeFee` pays the judge out of the escrow; see [`solive_wallet_escrow`](reference/mcp-tools.md#solive_wallet_escrow) and [`solive_wallet_attest`](reference/mcp-tools.md#solive_wallet_attest) for what each party may do. To settle, the judge signs `attestedProofMessage` and sends it in an Ed25519 instruction ahead of `buildFillAttested`. Here your wallet is owner, judge and worker at once so the block runs alone; in practice the judge signs with its own key and `payee` is the worker's token account. This prints `Filled`.

```ts
import { createHash } from "node:crypto";
import {
  attestedProofMessage,
  buildFillAttested,
  feeBpsFor,
  findAssociatedTokenAddress,
  findIntentPda,
  signEd25519Instruction,
} from "@intent-engine/core";

const judge = signer;
const specHash = new Uint8Array(createHash("sha256").update("the acceptance spec the work must pass").digest());
const pay = parseAmount("0.01", sell.decimals);
const job = await client.nextNonce(signer.address);
const work = { kind: Kind.AttestedResult, amountIn: pay, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash, judgeFee: pay / 10n } as const;
await client.send([await buildCreateIntent({ ...order, nonce: job, params: work })], signer);

const payee = await findAssociatedTokenAddress({ owner: signer.address, mint: WSOL, tokenProgram: sell.tokenProgram });
const [intent] = await findIntentPda({ owner: signer.address, nonce: job });
const maxFeeBps = feeBpsFor(config, Kind.AttestedResult);
const proof = { amountIn: pay, result: 1n, maxFeeBps };
const message = await attestedProofMessage(judge.address, { ...proof, domain: Uint8Array.from(config.domain), intent, payee, specHash });
await client.send(
  [
    await signEd25519Instruction(judge, message),
    await buildFillAttested({
      ...proof,
      solver: judge,
      owner: signer.address,
      nonce: job,
      inputMint: WSOL,
      inputTokenProgram: sell.tokenProgram,
      payee,
      feeRecipient: config.feeRecipient,
      judge: judge.address,
    }),
  ],
  judge,
);
console.log(statusOf((await client.intent(signer.address, job))?.intent.status ?? -1));
```

## Next

- [Errors](reference/errors.md)
- [Run a solver](solver.md)
