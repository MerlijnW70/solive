# Judge work

A proof escrow pays out only when its judge signs a release. `intent-engine judge` does the judge's work: it checks the spec, runs your check on the delivered work in a sandbox, and pays the worker only on a pass.

Do steps 1 and 2 of the [quickstart](quickstart.md) first. The default sandbox needs Docker. [How the judge works](maintainers/judge-internals.md) has every detail.

## Before you start

Your wallet is the judge. Put its address in `JUDGE`:

```sh
export JUDGE=$(intent-engine balance | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).address')
```

In PowerShell:

```powershell
$env:JUDGE = (intent-engine balance | Out-String | ConvertFrom-Json).address
```

## 1. Create a proof escrow

Whoever pays creates the escrow and names its judge. To try it alone, pay yourself. Write the spec to `spec.md`, publish it at an https URL and put that URL in place of `https://example.org/spec.md`:

```sh
export SPEC_URL=https://example.org/spec.md
export SPEC_HASH=$(intent-engine hash --artifact spec.md | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).sha256')
intent-engine create attested --input-mint SOL --output-mint TEST --units tokens --amount-in 0.01 --min-result 1 --max-result 1 --attestor $JUDGE --spec-hash $SPEC_HASH --judge-fee 0.001 --spec-url $SPEC_URL --expires-in 86400 --yes
```

In PowerShell:

```powershell
$env:SPEC_URL = "https://example.org/spec.md"
$env:SPEC_HASH = (intent-engine hash --artifact spec.md | Out-String | ConvertFrom-Json).sha256
intent-engine create attested --input-mint SOL --output-mint TEST --units tokens --amount-in 0.01 --min-result 1 --max-result 1 --attestor $env:JUDGE --spec-hash $env:SPEC_HASH --judge-fee 0.001 --spec-url $env:SPEC_URL --expires-in 86400 --yes
```

This escrows 0.01 SOL for a day and pays the judge 0.001 of it. When someone else pays, they pass your address as `--attestor` and you start at step 2.

## 2. Find the job and its spec

```sh
intent-engine jobs --attestor $JUDGE
```

Put the job's `intent`, `owner` and `nonce` in `INTENT`, `OWNER` and `NONCE`. If you do not have the spec yet, download it:

```sh
curl -fsSL -o spec.md "$SPEC_URL"
```

In PowerShell:

```powershell
curl.exe -fsSL -o spec.md $env:SPEC_URL
```

## 3. Fetch the delivery

```sh
intent-engine deliveries --attestor $JUDGE --intent $INTENT
```

In PowerShell:

```powershell
intent-engine deliveries --attestor $env:JUDGE --intent $env:INTENT
```

Each delivery names the work's `sha256`, the `worker` who announced it first and its `url`. Download the work into `work`, a file or a directory. Treat it as untrusted.

## 4. Write your check

The check is any command that exits 0 when the work passes the spec. `judge` gives it three environment variables: `SPEC_PATH`, the spec file; `ARTIFACT_PATH`, the work; `ARTIFACT_SHA256`, the work's hash. This check passes when `answer.txt` holds `42`:

```js
import { readFileSync } from "node:fs";
import { join } from "node:path";

const answer = readFileSync(join(process.env.ARTIFACT_PATH, "answer.txt"), "utf8");
process.exit(answer.trim() === "42" ? 0 : 1);
```

Save it as `check.mjs`. A bash script works too:

```bash
#!/usr/bin/env bash
set -euo pipefail
test "$(cat "$ARTIFACT_PATH/answer.txt")" = 42
```

Save it as `check.sh` and pass `--check check.sh --run "bash check/check.sh"` in place of the `--check` and `--run` of step 5.

## 5. Judge and settle

```sh
intent-engine judge --owner $OWNER --nonce $NONCE --spec spec.md --artifact work --check check.mjs --run "node check/check.mjs" --verdict verdict.json
```

In PowerShell:

```powershell
intent-engine judge --owner $env:OWNER --nonce $env:NONCE --spec spec.md --artifact work --check check.mjs --run "node check/check.mjs" --verdict verdict.json
```

This runs your check in a Docker container with no network and sends nothing. Add `--yes` to run it again and pay the worker on a pass:

```sh
intent-engine judge --owner $OWNER --nonce $NONCE --spec spec.md --artifact work --check check.mjs --run "node check/check.mjs" --verdict verdict.json --yes
```

In PowerShell:

```powershell
intent-engine judge --owner $env:OWNER --nonce $env:NONCE --spec spec.md --artifact work --check check.mjs --run "node check/check.mjs" --verdict verdict.json --yes
```

The release records the memo `delivery sha256:<artifactSha256>`. The payer checks it with `intent-engine receipt`.

## Keep judging

`judge --watch` takes the same options without `--artifact`; every `--interval` seconds (default 30) it downloads each new delivery from its `url`, checks it against the announced sha256 and judges it once. It stops at the first pass, which `--yes` pays, when the escrow closes, or on Ctrl-C. It prints one line of JSON per delivery it judged and one when it stops.

On devnet, testnet and mainnet it refuses a work link that points to a private or local network address.

## Judge the word count example

[`examples/jobs/word-count`](../examples/jobs/word-count) is a whole job: a spec, a passing delivery and its check. Run these from a clone of this repository. Try the check on the delivery, which prints `32 of 32 inputs hold`:

```sh
ARTIFACT_PATH=examples/jobs/word-count/delivery/wordcount.mjs node examples/jobs/word-count/check.mjs
```

In PowerShell:

```powershell
$env:ARTIFACT_PATH = "examples/jobs/word-count/delivery/wordcount.mjs"
node examples/jobs/word-count/check.mjs
```

An escrow for this job commits the sha256 that `intent-engine hash --artifact examples/jobs/word-count/SPEC.md` prints as its `specHash`. Create one as in step 1, with these values in place of the first two lines there:

```sh
export SPEC_URL=https://raw.githubusercontent.com/MerlijnW70/solive/main/examples/jobs/word-count/SPEC.md
export SPEC_HASH=$(intent-engine hash --artifact examples/jobs/word-count/SPEC.md | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).sha256')
```

In PowerShell:

```powershell
$env:SPEC_URL = "https://raw.githubusercontent.com/MerlijnW70/solive/main/examples/jobs/word-count/SPEC.md"
$env:SPEC_HASH = (intent-engine hash --artifact examples/jobs/word-count/SPEC.md | Out-String | ConvertFrom-Json).sha256
```

Its worker announces the plain sha256 of the file, the hash that `intent-engine hash --artifact examples/jobs/word-count/delivery/wordcount.mjs` prints. With `OWNER` and `NONCE` from step 2, judge and then settle it:

```sh
intent-engine judge --owner $OWNER --nonce $NONCE --spec examples/jobs/word-count/SPEC.md --artifact examples/jobs/word-count/delivery/wordcount.mjs --check examples/jobs/word-count/check.mjs --run "node check/check.mjs" --verdict verdict.json
intent-engine judge --owner $OWNER --nonce $NONCE --spec examples/jobs/word-count/SPEC.md --artifact examples/jobs/word-count/delivery/wordcount.mjs --check examples/jobs/word-count/check.mjs --run "node check/check.mjs" --verdict verdict.json --yes
```

In PowerShell:

```powershell
intent-engine judge --owner $env:OWNER --nonce $env:NONCE --spec examples/jobs/word-count/SPEC.md --artifact examples/jobs/word-count/delivery/wordcount.mjs --check examples/jobs/word-count/check.mjs --run "node check/check.mjs" --verdict verdict.json
intent-engine judge --owner $env:OWNER --nonce $env:NONCE --spec examples/jobs/word-count/SPEC.md --artifact examples/jobs/word-count/delivery/wordcount.mjs --check examples/jobs/word-count/check.mjs --run "node check/check.mjs" --verdict verdict.json --yes
```

## Judge without Docker

`--sandbox viper` judges a delivery that is one JavaScript module, with no Docker and no check of yours. It runs the cases the spec lists in [ViperJS](https://github.com/MerlijnW70/viperjs), a sandboxed JavaScript engine, and again in a second engine. With `OWNER` and `NONCE` from step 2:

```sh
intent-engine judge --owner $OWNER --nonce $NONCE --spec examples/jobs/word-count/SPEC.md --artifact examples/jobs/word-count/delivery/wordcount.mjs --sandbox viper --verdict verdict.json
intent-engine judge --owner $OWNER --nonce $NONCE --spec examples/jobs/word-count/SPEC.md --artifact examples/jobs/word-count/delivery/wordcount.mjs --sandbox viper --verdict verdict.json --yes
```

In PowerShell:

```powershell
intent-engine judge --owner $env:OWNER --nonce $env:NONCE --spec examples/jobs/word-count/SPEC.md --artifact examples/jobs/word-count/delivery/wordcount.mjs --sandbox viper --verdict verdict.json
intent-engine judge --owner $env:OWNER --nonce $env:NONCE --spec examples/jobs/word-count/SPEC.md --artifact examples/jobs/word-count/delivery/wordcount.mjs --sandbox viper --verdict verdict.json --yes
```

Add `--plain-node` to also run every case in plain Node inside Docker:

```sh
intent-engine judge --owner $OWNER --nonce $NONCE --spec examples/jobs/word-count/SPEC.md --artifact examples/jobs/word-count/delivery/wordcount.mjs --sandbox viper --plain-node --verdict verdict.json
```

In PowerShell:

```powershell
intent-engine judge --owner $env:OWNER --nonce $env:NONCE --spec examples/jobs/word-count/SPEC.md --artifact examples/jobs/word-count/delivery/wordcount.mjs --sandbox viper --plain-node --verdict verdict.json
```

## Who is paid

Anyone can copy an announcement, so `judge` pays the earliest announcer of the work's hash. It refuses when nobody announced it.

## Check a second node

`judge`, `committee release` and `mcp` take `--confirm-url <rpc>`, in the forms `--url` takes, to read the escrow and the earliest announcer from a second RPC node too. A release is signed only when both nodes report the same genesis hash, escrow account and earliest announcer. Otherwise, or when the second node cannot be read, it is refused with `ConfirmMismatch` and nothing is sent.

## Judge as a committee

A committee needs a `threshold` of its members to agree before an escrow pays, so one judge is no longer a single point of failure.

```powershell
intent-engine committee create --keypair payer.json --members $env:A,$env:B,$env:C --threshold 2 --fee-wallet $env:FEES --yes
```

Pass the printed `committee` address as `--attestor` when you create the escrow. Each member judges on their own; a pass writes that member's signed vote to the verdict file:

```powershell
intent-engine judge --keypair a.json --owner $env:OWNER --nonce $env:NONCE --spec SPEC.md --artifact work.mjs --sandbox viper --verdict a.json.verdict
```

Any member who voted then submits the votes:

```powershell
intent-engine committee release --keypair a.json --vote a.json.verdict --vote b.json.verdict --sha256 $env:WORK --yes
```

## Job claims

With claims, a worker holds a job for a while against a stake, and only that worker can be paid while the claim holds. The owner opens claims:

```powershell
intent-engine claims open --keypair owner.json --nonce $env:NONCE --max-secs 7200 --stake 0.05 --yes
```

A worker reads the board and takes the job:

```powershell
intent-engine claims show --owner $env:OWNER --nonce $env:NONCE
intent-engine claims take --keypair worker.json --owner $env:OWNER --nonce $env:NONCE --secs 3600 --yes
```

A worker that drops its claim gets its stake back. A claim that lapses loses its stake to the owner.

## Next

- [How the judge works](maintainers/judge-internals.md)
- [Company-only jobs](private-jobs.md)
- [Reputation](reputation.md)
- [All commands](reference/cli.md)
