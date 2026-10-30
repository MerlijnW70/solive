# Judge work

A proof escrow pays out only when its judge signs a release. `intent-engine judge` does the judge's work: it checks the spec, runs your check on the delivered work in a sandbox, and pays the worker only on a pass.

Do steps 1 and 2 of the [quickstart](quickstart.md) first. The default sandbox needs Docker. [How the judge works](maintainers/judge-internals.md) has every detail, and [Judging untrusted work](#judging-untrusted-work) below the safe command line.

## Before you start

Your wallet is the judge. Put its address in `JUDGE`:

```sh
export JUDGE=$(intent-engine balance | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).address')
```

In PowerShell:

```powershell
$env:JUDGE = (intent-engine balance | Out-String | ConvertFrom-Json).address
```

The judge's wallet can be a Ledger: pass `--keypair usb://ledger` or another Ledger form to `judge`, with or without `--watch`, and `--fee-payer <key file>`. The Ledger signs only the message over the proof, shown as a hex digest, and never a transaction, so a host cannot add an instruction to what it signs. The fee-payer key signs and pays the release transaction; without it the judge is refused.

A Ledger cannot open what workers seal to the judge, so a judge on a Ledger opens their announcements with an encryption key file, which only decrypts and never signs. Make one with `intent-engine profile encryption-key new --out judge.enc`, then publish the `encryption_key` it prints in the judge's profile, signed on the Ledger: `profile set --keypair usb://ledger --skills judge --endpoint <https url> --encryption-key <key> --yes`.

Workers then seal each announcement to that key, and each announcement lists a short fingerprint of every key it was sealed to. Pass `--encryption-keypair judge.enc` to `judge`, with or without `--watch`, and to `deliveries`.

`judge` pays the first announcement that opens to the work with the keys it is given. An earlier announcement sealed to a key it was not given stops the release and names that key; nothing is signed. An earlier one sealed to a key it holds that does not open can never open for anyone, so `judge` passes over it and lists it under `skipped`.

`judge` also passes over and lists an earlier announcement that is not a delivery to this escrow, with its reason in plain words: one whose wallet slot names a key other than the one derived from the wallet assigned to that slot, or a committee escrow's announcement sealed to more or fewer recipients than the committee has members.

A Ledger judge must publish its encryption key before the escrow is made: it refuses an escrow made while its profile named no key, since work sealed to its wallet key would stall it. While an open escrow names it, `profile set --encryption-key none`, `profile close` and the MCP profile tool refuse on a Ledger wallet; rotating to a new key stays allowed.

Hirers see a warning when they name a judge whose profile has no key. When the profile's history cannot be read back far enough, the judge refuses rather than guess.

Rotate only between escrows, and after a new key replaces the old one, repeat `--encryption-keypair` once per key file, so that announcements sealed to the old key still open.

A worker on a Ledger cannot sign messages, so `deliver` gives it random delivery secrets and writes them, with the url, to a file under `~/.config/intent-engine/secrets` that only its owner can read; `refute` reads that file later. A committee member can vote on a Ledger too, as below.

An MCP wallet on a Ledger releases the same way: start it with `mcp --wallet --fee-payer <key file>`, or `wallet_attest` and `wallet_attest_split` are refused with `NoFeePayer`. Their previews show the `digest` the device signs.

For a transaction the wallet itself signs on the device, the preview shows the `message_hash` the device shows, and a send with the same arguments, plus what the preview said to pass back, signs exactly that kept transaction; without one, or once it expired, the send is refused with `DeviceUnpreviewed`.

Start an MCP wallet on a Ledger with `--encryption-keypair <file>` too, repeated per key file, so it opens what workers seal to its profile key. Without it, `wallet_attest`, `wallet_attest_split` and `wallet_committee_vote` refuse announced work with `KeyNotGiven`.

A preview without `--yes` asks the device for nothing and prints the `digest` it will sign, with the `announcement`, `artifactSha256` and `salt` it pays. Before you approve, run `intent-engine judge digest --owner <address> --nonce <n> --announcement <address> --sha256 <hex> --salt <hex>` with those values on a second machine. It reads the chain and prints the digest the Ledger should show; reject on any difference.

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
intent-engine deliveries --intent $INTENT
```

In PowerShell:

```powershell
intent-engine deliveries --intent $env:INTENT
```

`deliveries` prints the escrow's `intent` and its `announcements` in `seq` order, read from accounts: each one's `announcement` address, `worker`, the `commitment` that binds the work's sha256 to that wallet and a salt, its `state`, `announced` or `paid`, and the `slot` and `announced_at` time it landed. `complete` is true when every seq below `next_seq` is listed, `missing` names any the node did not return, and `closed` says the escrow is no longer open.

Add `--judge-keypair` with the judge's or a committee member's key file, or `--encryption-keypair`, and each announcement those keys open shows its `url`.

`judge` pays the first announcement that opens to the work's hash, so a copy announced later from another wallet is never paid. Download the work into `work`, a file or a directory, and treat it as untrusted.

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

The release pays the announcement the verdict names and records its sha256 and salt on chain. The payer checks it with `intent-engine receipt`.

## Keep judging

`judge --watch` takes the same options without `--artifact`; every `--interval` seconds (default 30) it lists the announcements to its judge from accounts, opens each new one, downloads the work from its `url`, checks it against the announcement's commitment and judges it once. It stops at the first pass, which `--yes` pays, when the escrow closes, or on Ctrl-C. It prints one line of JSON per delivery it judged and one when it stops.

A failed check is final: that work is not judged again. A refusal that can change, because another wallet holds the escrow's claim, the node lists the announcements incompletely, an earlier announcement is sealed to a key not given, or the RPC node failed, prints a line with `retry: true` and is tried again next round; the same refusal prints once. Each escrow is still paid at most once.

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

## Judging untrusted work

Delivered work is hostile until proven otherwise. A worker's patch that your check builds or runs, or a file a parser opens, runs code you did not write. Judge it only inside the Docker sandbox, on an image pinned by its digest:

```sh
intent-engine sandbox doctor --sandbox-image $IMAGE
intent-engine judge --owner $OWNER --nonce $NONCE --spec spec.md --artifact work --run "$CHECK" --sandbox docker --sandbox-image $IMAGE --timeout 1800 --verdict verdict.json --yes
```

In PowerShell:

```powershell
intent-engine sandbox doctor --sandbox-image $env:IMAGE
intent-engine judge --owner $env:OWNER --nonce $env:NONCE --spec spec.md --artifact work --run "$env:CHECK" --sandbox docker --sandbox-image $env:IMAGE --timeout 1800 --verdict verdict.json --yes
```

`$IMAGE` is `<name>@sha256:<digest>`; `judge` refuses a tag alone. `sandbox doctor` must print `"ready": true` on the machine before it judges. Never pass `--sandbox none` for such work. Exit code 75 is an infrastructure error, such as a timeout or Docker down: nothing was signed, so run it again.

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

`--sandbox viper` needs neither WSL nor Docker on Windows: a demo job is judged from PowerShell as is. Save the spec and the work byte for byte, such as with `curl.exe -o`; `Set-Content` adds a byte-order mark or line ends that change the sha256, and `judge` then says so.

An AI with the MCP wallet judges such a delivery with `solive_wallet_judge_work`, with no file and no shell. It fetches the escrow's spec and the announced work, runs the cases in both engines and returns the verdict, each engine's failed cases and the work's sha256, and sends nothing. On a pass, `solive_wallet_attest` with that sha256 pays.

`solive_wallet_judge_work` refuses a spec without a `judge-cases` block: judge that with `--sandbox docker`. It does not wait for drawn cases, so it refuses a spec with a `draw`.

So that a delivery cannot answer from a table of the published cases, the spec's `judge-cases` block can add `"draw": {"count": n, "generator": "<module>", "checker": "<module>", "k": K}`. `judge` then waits until the first block at or after the earliest announcement's slot plus `K` is finalized, and seeds the draw with the sha256 of a fixed tag, that block's hash, the intent and the work's sha256.

The generator's single `export default` gets the seed in hex and `n` and returns `n` argument lists; the checker's gets one list and the delivery's answer and returns `true` or `false`, each in a fresh ViperJS engine with the spec's budgets. `judge` passes only when every published and drawn case passes, and refuses a spec whose generator or checker fails as the spec's fault.

A drawn case accepts an answer that is null, `true`, `false`, a finite number, or a string with no lone surrogate; only these reach the checker, exactly as the delivery returned them, U+FFFD included. Every other answer fails the case: `undefined` as `wrong`, an object as `not-primitive`, and `NaN`, `Infinity`, `-Infinity` or a string holding a lone surrogate such as `"\ud800"` as `not-primitive` with a `detail` naming the reason.

`judge` refuses a spec whose arguments, expected answers, generator or checker hold a lone surrogate such as `"\ud800"`, which UTF-8 cannot carry, so the engines would receive different strings. It refuses drawn arguments that hold one the same way. Nothing is run or paid.

The verdict's `drawn` records the slot, blockhash and seed, so anyone with the spec and a node that keeps the full ledger regenerates the same cases.

## Who is paid

`judge` pays the first announcement, in `seq` order, that opens to the work's hash, so a copied announcement pays nobody else. The salt and the sealing keys come from the worker's own signature, so nobody without the worker's key can test a guessed hash against a commitment.

It refuses while the list of announcements is incomplete, while an earlier announcement is sealed to a key it was not given, while another worker holds the job's claim, and when nobody announced the work.

The release names the paid announcement and records the hash and its salt. An earlier worker whose announcement of the same work was passed over runs `intent-engine refute --earlier <its announcement> --paid <paid announcement> --work-url <its url> --yes`, which reveals its announcement's secrets on chain. `reputation` counts a refutation against every wallet the release paid, the announcer and the co-authors of a split, only when that earlier announcement opens to the paid work.

A split release pays each co-author into its canonical token account. When that account cannot take the share, because it requires memos, is frozen or is closed, the release pays everyone else and holds that share in the escrow for its co-author. `intent-engine claim-held --keypair <file>` lists the shares held for that wallet, and `--announcement <paid announcement> --to <token account> --yes` claims one into any token account the wallet owns; `wallet_claim_held` does the same over MCP.

The escrow cannot close while it holds a share: `close` refuses it, `crank` passes over it and the program fails with `SharesHeld`, until the share is claimed or a year after the escrow expires, when the share returns to the owner.

`receipt` names each held share with its `state`: `held`, `received` once claimed, or `returned` to the owner with the close transaction. It also names a fee whose account could not take it, the protocol fee too, under `withheld`. `wallet_history` and `get_reputation` show a returned share as `returned`, outside the co-author's pay.

Once an escrow closes, `intent-engine reclaim` closes the worker's announcements that may close and returns their rent; it keeps an earlier announcement that can still refute a paid release until 30 days after that release, and `close-book --intent <address>` closes an escrow's empty delivery book.

This cannot stop a copier who announces every value of a small answer set first, or one who copies work published before its announcement lands. A job claim or a spec with many possible answers covers those.

## Check a second node

`judge`, `committee release` and `mcp` take `--confirm-url <rpc>`, in the forms `--url` takes, to read the escrow and its announcements from a second RPC node too. A release is signed only when both nodes report the same genesis hash, escrow account, delivery book, announcements and first announcement that opens to the work. Otherwise, or when the second node cannot be read, it is refused with `ConfirmMismatch` and nothing is sent.

`intent-engine setup --confirm-url <rpc>` checks that the node answers on the same cluster, by genesis hash, then saves it as the `confirm-url` setting. These three commands use the setting whenever `--confirm-url` is not given; other commands, such as `judge digest`, ignore it. `--no-confirm-url` skips the setting for one run. A second node at the same endpoint as `--url` is refused. Without a second node, they print once that they read one node.

## Judge as a committee

A committee needs a `threshold` of its members to agree before an escrow pays.

```powershell
intent-engine committee create --keypair payer.json --members $env:A,$env:B,$env:C --threshold 2 --fee-wallet $env:FEES --yes
```

An MCP wallet creates one with `solive_wallet_committee_create`, votes with `solive_wallet_committee_vote` and releases with `solive_wallet_committee_release`, all served with `--wallet`.

The admin can set a committee floor per token with `set-committee-floor --mint <mint> --floor <raw>`, and `show config` lists the floors under `committeeFloors`. The engine refuses a proof escrow of at least its token's floor with `CommitteeRequired` unless its attestor is a committee with a threshold of two or more. `create attested` and the escrow tools say so before sending, and pass the committee with the create.

Pass the printed `committee` address as `--attestor` when you create the escrow. Each member judges on their own; a pass writes that member's signed vote to the verdict file:

```powershell
intent-engine judge --keypair a.json --owner $env:OWNER --nonce $env:NONCE --spec SPEC.md --artifact work.mjs --sandbox viper --verdict a.json.verdict
```

A member whose key is on a Ledger votes with `committee vote --keypair usb://ledger --encryption-keypair <file>` and the same `--owner`, `--nonce` and `--result`, the work's `--sha256`, plus `--out` for the vote file and `--yes`. The device shows one message that lists every member's key and the release digest, the `digest` the preview prints, and signs no transaction. A vote stays valid whichever members reach the threshold.

A member on a Ledger can also judge, with `judge --keypair usb://ledger --fee-payer <key file> --encryption-keypair <file>`. It opens the announcements with the encryption key its profile publishes and, with `--yes`, signs its vote on the device; without `--yes` it prints the vote's `digest` and signs nothing. Without an encryption key file it refuses announced work.

Because that message lists every member, a release by a large committee, especially one that also splits the pay, can exceed the size of one Solana transaction; keep committees small or the escrow can only be cancelled.

Each vote names the `announcement` it pays, the work's `sha256` and that announcement's `salt`. `committee release` refuses votes that differ in any of them, and pays that announcement.

Any member who voted then submits the votes:

```powershell
intent-engine committee release --keypair a.json --vote a.json.verdict --vote b.json.verdict --yes
```

## Job claims

With claims, a worker holds a job for a while against a stake, and only that worker can be paid while the claim holds. A stake is 0 or at least 0.00089088 SOL, the rent-exempt minimum of a wallet, so it can always be paid to an empty wallet. The owner opens claims:

```powershell
intent-engine claims open --keypair owner.json --nonce $env:NONCE --max-secs 7200 --stake 0.05 --yes
```

A worker reads the board and takes the job:

```powershell
intent-engine claims show --owner $env:OWNER --nonce $env:NONCE
intent-engine claims take --keypair worker.json --owner $env:OWNER --nonce $env:NONCE --secs 3600 --yes
```

A worker that drops its claim gets its stake back. A claim that lapses loses its stake to the owner.

While a job is held, another worker can stand by in its first-in, first-out line, locking the same stake; the holder cannot. While anyone stands by, nobody claims the job directly, and a drop hands it to the first worker still in the line. An entry of the worker that dropped, reached before its term ends, closes and returns its stake and rent instead.

Once a claim lapses, anyone can run `claims advance`, which forfeits the lapsed stake to the owner and hands the job on. A waiter takes back its stake and rent with `claims leave`, and anyone can do that for it once the escrow is no longer open. `jobs` counts the waiters as `waiting`.

```powershell
intent-engine claims standby --keypair worker.json --owner $env:OWNER --nonce $env:NONCE --secs 3600 --yes
```

## Next

- [How the judge works](maintainers/judge-internals.md)
- [Company-only jobs](private-jobs.md)
- [Reputation](reputation.md)
- [All commands](reference/cli.md)
