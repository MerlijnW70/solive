# Your first paid job

Post a job, do it, judge it and get paid on Solana devnet, playing both sides from the command line. Then try to cheat and watch it fail. Devnet tokens have no value.

A job is a proof escrow: it locks the pay and commits to the spec's hash, and only its judge can release the pay, to the wallet that first announced work that passes.

Install the CLI as in step 1 of the [quickstart](quickstart.md). You also need the [Solana CLI](https://solana.com/docs/intro/installation).

## 1. Make two wallets

Your own wallet hires and judges:

```sh
intent-engine setup
```

It prints your `address` and the `keypair` file that holds it, and asks devnet for 1 SOL when it holds little. If devnet refuses, open the faucet link it prints. If you ran the quickstart, it is the same wallet.

Make a second wallet that works, and send it 0.01 SOL from yours for its network fees. Put your `keypair` file in place of `<keypair>`:

```sh
solana-keygen new --no-bip39-passphrase -o worker.json
solana transfer --url devnet --keypair <keypair> worker.json 0.01 --allow-unfunded-recipient
```

## 2. Post the job

Save this spec as `spec.md`:

````md
# Answer 42

Deliver one JavaScript module whose default export returns 42.

```judge-cases
{"cases": [{"args": [], "expected": 42}]}
```
````

The `judge-cases` block is the check: the judge runs the module's default export and pays only when it returns 42. Print the spec's hash:

```sh
intent-engine hash --artifact spec.md
```

Post the job with 0.01 SOL of pay for a day, and your own wallet as the judge. Put your `address` in place of `<address>` and the `sha256` from `hash` in place of `<sha256>`:

```sh
intent-engine create attested --input-mint SOL --output-mint TEST --units tokens --amount-in 0.01 --min-result 1 --max-result 1 --attestor <address> --spec-hash <sha256> --expires-in 86400 --yes
```

It prints the job's `intent` and `nonce`. The 0.01 SOL leaves your wallet and waits in the escrow.

## 3. Deliver wrong work

As the worker, find the job by its judge, your `address`, and check the spec:

```sh
intent-engine jobs --attestor <address>
intent-engine hash --artifact spec.md
```

`jobs` lists your job with its `intent`, its `specHash` and its `net_pay`: what the worker gets, the 0.01 less the protocol fee. `hash` prints the same `sha256` as `specHash`, so the `spec.md` you hold is the spec the job pays for. Work on a job only when they match.

Save this wrong work as `wrong.mjs`:

```js
export default () => 41;
```

Announce it to the judge, with the job's `intent` in place of `<intent>`:

```sh
intent-engine deliver --keypair worker.json --intent <intent> --artifact wrong.mjs --work-url https://example.org/wrong.mjs --yes
```

`--work-url` tells the judge where to download the work. Here the judge already has the file, so the link is not opened.

As the judge, check it, with the job's `nonce` in place of `<nonce>`:

```sh
intent-engine judge --owner <address> --nonce <nonce> --spec spec.md --artifact wrong.mjs --sandbox viper --yes
intent-engine balance --keypair worker.json
```

`--sandbox viper` runs the module in a sandboxed JavaScript engine, so no Docker is needed. `judge` prints `"verdict": "fail"`: the module returned 41 where the spec wants 42, so it sends nothing. `balance` shows the worker's `wrapped SOL` at `0`. Each `judge` first warns that it reads one RPC node, which is fine for a test job.

## 4. Deliver the right work

Save this as `right.mjs`:

```js
export default () => 42;
```

Announce it as the worker, then check it and pay as the judge:

```sh
intent-engine deliver --keypair worker.json --intent <intent> --artifact right.mjs --work-url https://example.org/right.mjs --yes
intent-engine judge --owner <address> --nonce <nonce> --spec spec.md --artifact right.mjs --sandbox viper --yes
```

`judge` prints `"verdict": "pass"`, the worker's address as `payTo` and the `signature` of the release. Read the receipt:

```sh
intent-engine receipt --owner <address> --nonce <nonce>
solana-keygen pubkey worker.json
```

The receipt shows who was paid as `paid_to`, the address `solana-keygen` prints, how much as `paid`, the job's `net_pay`, and for which work as `delivered_sha256`, the `sha256` that `intent-engine hash --artifact right.mjs` prints. `"valid": true` means the release paid the wallet that announced that work first. The pay arrives as wrapped SOL, SOL held as a token.

## 5. Try two cheats

A third wallet copies the paid work and announces it as its own:

```sh
solana-keygen new --no-bip39-passphrase -o copier.json
intent-engine deliver --keypair copier.json --intent <intent> --artifact right.mjs --work-url https://example.org/right.mjs --yes
```

`deliver` refuses: the job is paid and no longer open, so the copier gets nothing. It needs no SOL, since nothing is sent. A copy announced before the release fails too: the judge pays only the wallet that announced the work first.

Now try to pay the same job twice:

```sh
intent-engine judge --owner <address> --nonce <nonce> --spec spec.md --artifact right.mjs --sandbox viper --yes
```

`judge` refuses, since the job is no longer open, and sends nothing.

## Next

Do the same from your AI: [Earn and hire](ai.md#earn-and-hire).
