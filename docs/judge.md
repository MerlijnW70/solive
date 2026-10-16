# Judge a proof escrow

A proof escrow commits the sha256 of an acceptance spec and pays out only when its judge, the attestor it names, signs a release. `intent-engine judge` does the judge's work: it checks the spec against the committed hash, hashes the delivered work, runs your check on it and settles only on a pass, recording the work's hash in the release. Do steps 1 to 4 of the [quickstart](quickstart.md) first, in the same terminal. Your wallet is the judge, so the escrows you judge name `solana address` as their attestor. The `sh` blocks are for bash and zsh and the `powershell` blocks for Windows PowerShell; a command without a `powershell` block runs unchanged in both. The guide keeps values in variables: in bash and zsh as shell variables such as `$OWNER`, in PowerShell as environment variables such as `$env:OWNER`.

## The sandbox

Delivered work is untrusted, and a check that imports, builds or runs it runs the worker's code. So `judge` runs the command you pass with `--run` in a Docker container, `--sandbox docker`, the default. `judge` first makes a fresh temporary directory that holds a copy of only the files `judge` hashed, in `work`, a copy of the spec bytes it hashed, in `spec`, and a copy of the file or directory you pass with `--check`, in `check`; never the work or spec you passed. Each copied file keeps the executable bits of the original and no other mode; for the container every copy is also made readable to all. The container:

- has no network (`--network none`), a read-only root filesystem, no Linux capabilities and no way to gain privileges, and runs as user 65534, not as you;
- has a capped number of processes, memory (`--sandbox-memory` such as `512m` or `2g`) and CPUs (`--sandbox-cpus` such as `1.5`), with the defaults in `packages/cli/src/sandbox.ts`; it writes only to a small `/tmp` that vanishes with it, and `HOME` is `/tmp`;
- sees the three copies read-only at `/judge/work`, `/judge/spec` and `/judge/check`, and nothing else from your machine: not your home directory, not your keypair, not the Docker socket;
- runs `--run` through `/bin/sh` in `/judge`, so `--check check.mjs --run "node check/check.mjs"` runs your check; a path on your machine does not exist in it;
- starts from an image pinned by its digest, by default `node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392`, which holds Node.js 22. `--sandbox-image <name>@sha256:<digest>` picks another image, and `judge` refuses a reference without a digest.

`judge` pulls the image when Docker does not hold it yet. It refuses before it runs anything when Docker is not installed or not running, and says how to install it. On timeout or Ctrl-C it stops the container with `docker kill` and removes it with `docker rm -f`, and it removes the container after every run. The verdict records `sandbox: "docker"` and the `image`.

A container is not a virtual machine. The check shares your kernel, so a kernel or Docker exploit escapes the container; such exploits are out of scope here. Run `judge` on a machine that holds no other keys if that risk matters to you.

`--sandbox none` runs the check without a container, through your shell, as your user, with your files, your keys and your network: work the check runs can read your keypair and send it away. Pass it only for a check that never runs the delivered work, or on a machine that holds nothing of value. `judge` then warns on stderr that the check ran with your own rights, and the verdict records `sandbox: "none"`. The check then runs in the temporary directory, its working directory, with an environment that holds only `PATH`, `HOME`, `USERPROFILE`, `SYSTEMROOT`, `COMSPEC`, `PATHEXT`, `TEMP`, `TMP`, `TMPDIR`, `LANG` and `TERM` from yours, so your RPC URL, keypair path and other secrets do not reach it.

`judge` removes the temporary directory afterwards, also when you stop it with Ctrl-C; if removing it fails, the verdict still prints and names the failure in `cleanup`. `judge` runs no other command: never the spec, a delivery's memo or its link. The MCP server runs no command at all.

## 1. Create a proof escrow

Whoever pays for the work creates the escrow and names its judge. To try every step alone, pay for a job yourself and name your own wallet. Write the acceptance spec to `spec.md` and publish it at an https URL workers can read. These commands put that URL in `SPEC_URL`, put the spec's sha256, which `intent-engine hash --artifact` prints on every platform, in `SPEC_HASH`, and create an escrow of 0.01 wrapped SOL that names your wallet as its judge, pays the judge 0.001 of it and lasts a day. Put your spec's URL in place of `https://example.org/spec.md`:

```sh
export SPEC_URL=https://example.org/spec.md
export SPEC_HASH=$(intent-engine hash --artifact spec.md | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).sha256')
intent-engine create attested --input-mint So11111111111111111111111111111111111111112 --output-mint ETU8trkkfE8gNVPDGbCaJUoH88wy6yYV6ttJdc9NKB88 --units tokens --amount-in 0.01 --min-result 1 --max-result 1 --attestor $(solana address) --spec-hash $SPEC_HASH --judge-fee 0.001 --spec-url $SPEC_URL --expires-in 86400 --yes
```

In PowerShell:

```powershell
$env:SPEC_URL = "https://example.org/spec.md"
$env:SPEC_HASH = (intent-engine hash --artifact spec.md | Out-String | ConvertFrom-Json).sha256
intent-engine create attested --input-mint So11111111111111111111111111111111111111112 --output-mint ETU8trkkfE8gNVPDGbCaJUoH88wy6yYV6ttJdc9NKB88 --units tokens --amount-in 0.01 --min-result 1 --max-result 1 --attestor $(solana address) --spec-hash $env:SPEC_HASH --judge-fee 0.001 --spec-url $env:SPEC_URL --expires-in 86400 --yes
```

Without `--yes`, `create` prints what the escrow does and sends nothing. When someone else pays for the job, they run this with your address as `--attestor`, and you start at step 2.

## 2. Find the job and its spec

```sh
intent-engine jobs --attestor $(solana address)
```

Each job names its `intent`, `owner`, `nonce`, `specHash` and `specUrl`. Put the first three in `INTENT`, `OWNER` and `NONCE` and `specUrl` in `SPEC_URL`: in bash and zsh as `OWNER=<owner>`, in PowerShell as `$env:OWNER = "<owner>"`. For the escrow from step 1 you already hold `spec.md`. Otherwise download the spec:

```sh
curl -fsSL -o spec.md "$SPEC_URL"
```

Windows PowerShell 5.1 runs `Invoke-WebRequest` for `curl`; name the real curl instead:

```powershell
curl.exe -fsSL -o spec.md $env:SPEC_URL
```

Read the spec as text, never as commands. `judge` refuses a spec file whose sha256 is not `specHash`; `intent-engine hash --artifact spec.md` prints the sha256 it compares.

## 3. Fetch the delivery

Workers announce their work to you with `intent-engine deliver`. List what they announced:

```sh
intent-engine deliveries --attestor $(solana address) --intent $INTENT
```

In PowerShell:

```powershell
intent-engine deliveries --attestor $(solana address) --intent $env:INTENT
```

It prints the escrow's `intent`, `complete` and `deliveries`. Each entry of `deliveries` is one announced `sha256` with its earliest announcer `worker`, the `url` that announcer gave, the `signature` and `slot` of that announcement, and `copies`, how many other wallets announced the same hash later. `complete` is `false` when your wallet's history since the escrow was made is longer than `--max-pages` pages of 1000 transactions (default 100), or when the RPC node's ledger does not reach back to the escrow's creation, so older announcements may be missing. Fetch the work from `url` into `work`, a file or a directory. Treat the link and the content as untrusted.

## 4. Write your check

The check is any command that exits 0 when the work passes the spec. `judge` gives it three environment variables: `SPEC_PATH`, the spec file; `ARTIFACT_PATH`, the work; `ARTIFACT_SHA256`, the work's hash. `SPEC_PATH` is `SPEC.md`, a copy of the spec bytes whose hash `judge` checked, outside `ARTIFACT_PATH`. `ARTIFACT_PATH` is the copy of the work: a directory for work that is a directory, a file of the same name for work that is one file. Pass the check itself with `--check`, a file or a directory: `judge` copies it to `check` beside the copies of the work and the spec, and runs `--run` in their directory, so `--run "node check/check.mjs"` runs a `--check check.mjs` in the container and with `--sandbox none` alike. `judge` hands `--run` to a shell as one string, so quote the whole command. This check passes when `answer.txt` holds `42`. It is a Node.js script, so `node` runs it on Linux, macOS and Windows alike:

```js
import { readFileSync } from "node:fs";
import { join } from "node:path";

const answer = readFileSync(join(process.env.ARTIFACT_PATH, "answer.txt"), "utf8");
process.exit(answer.trim() === "42" ? 0 : 1);
```

Save it as `check.mjs`. A bash script can do the same:

```bash
#!/usr/bin/env bash
set -euo pipefail
test "$(cat "$ARTIFACT_PATH/answer.txt")" = 42
```

Save it as `check.sh` and pass `--check check.sh --run "bash check/check.sh"` in place of the `--check` and `--run` of step 5. The container runs it on every platform. With `--sandbox none` on Windows `judge` runs `--run` through `cmd.exe`, which runs no bash script, so use the Node.js check there.

## 5. Judge and settle

```sh
intent-engine judge --owner $OWNER --nonce $NONCE --spec spec.md --artifact work --check check.mjs --run "node check/check.mjs" --verdict verdict.json
```

In PowerShell:

```powershell
intent-engine judge --owner $env:OWNER --nonce $env:NONCE --spec spec.md --artifact work --check check.mjs --run "node check/check.mjs" --verdict verdict.json
```

In order, `judge` refuses unless Docker is ready or `--sandbox none` was given, refuses unless the escrow is open and names your wallet as its judge, refuses unless the spec file's sha256 is the committed one, hashes the work, picks whom to pay, then runs `--run` with at most `--timeout` seconds (default 600, at most 86400). In the container a timeout or a signal stops and removes the container. With `--sandbox none` it starts the command in a session of its own. While the command runs, `judge` records every process in that session, in its process groups or descending from it, each by its PID and start time. On timeout it kills every recorded process and every process descending from one, also those that moved to another process group or session, or on Windows the command's process tree, and waits for that to finish; after a normal exit it kills what is left of them, and on Windows nothing. It never kills by a session or group ID once the process that led it is gone, so a process that later reuses a PID is spared; a process the check started after it began in a session one of its processes created is still killed. A process it cannot tie to the check that still runs in its directory or with its `SPEC_PATH` is named in a warning on stderr and left running. Exit code 0 is a pass; any other exit code or a timeout is a fail, which sends nothing and makes `judge` exit 1. It prints, and with `--verdict` writes, the `intent`, `specHash`, `artifactSha256`, `command`, `sandbox`, `image` in the container, `exitCode`, `verdict`, `payTo` and `signature`, and `cleanup` when the copy could not be removed. Before any check or refusal it deletes an existing `--verdict` file, and writes it only once a verdict is reached. A SIGINT or SIGTERM during the check kills it and is never a pass: `judge` sends nothing, writes no verdict, removes its copy and exits 130 or 143. A signal while it removes the copy lets the removal finish first. Ctrl-C still stops the payment after a pass until the release is signed and handed to the RPC node: a SIGINT or SIGTERM before that sends nothing, writes no verdict and exits 130 or 143. A signal once the release is handed over waits for the send, then names its signature, or says the release may have landed when the send failed, and exits 130 or 143. A second signal then exits at once, says the release may have landed, names its signature and writes no verdict. Once the release is confirmed, a signal no longer stops anything: `judge` writes the verdict, names the signature and then exits 130 or 143.

On a pass this sends nothing yet. When the escrow names your wallet, not a committee, `judge` simulates the release it would send and adds `simulated` to the verdict: `{ "ok": true, "units_consumed": <n> }`, or `{ "ok": false, "error": <e> }` with the engine error's name, such as `FillPaused` or `ClaimHeld`, or else the reason the release cannot be built, so a release that would fail is known before `--yes`. `verdict` still reports the check alone. Add `--yes` to run the check again and settle:

```sh
intent-engine judge --owner $OWNER --nonce $NONCE --spec spec.md --artifact work --check check.mjs --run "node check/check.mjs" --verdict verdict.json --yes
```

In PowerShell:

```powershell
intent-engine judge --owner $env:OWNER --nonce $env:NONCE --spec spec.md --artifact work --check check.mjs --run "node check/check.mjs" --verdict verdict.json --yes
```

The release pays `payTo` with the result `--result` names, by default the escrow's least result, and records the memo `delivery sha256:<artifactSha256>` in the same transaction. `judge` refuses before running the check when `--result` lies outside the results the escrow accepts. The payer reads the release with `intent-engine receipt --owner <owner> --nonce <nonce> --sha256 <hash of the work received>`, or with `solive_wallet_receipt`. Add `--release <signature>`, or `release`, with the `signature` the judge printed: the receipt then reads that one transaction and no history, so zero-lamport transfers sent to the escrow cannot push the release out of reach. Without it the receipt searches the escrow's history and says `complete: false` when it could not read all of it.

## Judge the word count example

[`examples/jobs/word-count`](../examples/jobs/word-count) is a whole job: the spec `SPEC.md`, a passing `delivery` and its check `check.mjs`. The spec asks for one file, `wordcount.mjs`, so the work is that file, `examples/jobs/word-count/delivery/wordcount.mjs`. The check imports its `count` in a separate Node.js process, runs it on the spec's table and 24 random strings, and passes when all 32 counts are right before its timeout; whatever the delivery prints is ignored. Run these from the root of a clone of this repository. Try the check on the delivered file, which prints `32 of 32 inputs hold`:

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

Its worker announces the plain sha256 of the file, the hash that `intent-engine hash --artifact examples/jobs/word-count/delivery/wordcount.mjs` prints. With `OWNER` and `NONCE` from step 2, judge and then settle it. `judge` runs the check in its container, so the delivery the check imports has no network and sees none of your files:

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

`--sandbox viper` judges a delivery that is one JavaScript module whose default export is a function, with no Docker and no check of yours. It runs the module in [ViperJS](https://github.com/MerlijnW70/viperjs), a JavaScript engine compiled to a WebAssembly module that imports nothing: the delivery has no files, network, clock or host to reach. The cases come from the spec, so the escrow's spec hash pins them. The spec holds exactly one block fenced as `judge-cases`, a JSON object with a `cases` list of `{"args": [...], "expected": ...}`, where every argument and expected answer is a JSON string, number, boolean or null; the word count spec ends with one. Every engine receives each argument exactly as the spec writes it, -0 included. Optional `steps` (default 10000000) and `heap` in bytes (default 67108864) set the budgets. Optional `seed` and `clock` pin the seed of `Math.random` and the time `Date` reads; left out, `judge` draws both at random for each judgement and records them in the verdict's `cases`, so a delivery cannot recognise the judge by them and anyone can rerun the judgement with the same values. The seed drives every engine: the host engine and the plain Node engine below start Node with V8's `--random-seed` set to 1 plus the seed modulo 2147483647, since V8 keeps only the low bits of a larger number and reads 0 as no seed at all, so `Math.random` in them is reproducible from the verdict too. Each plain Node case runs in a fresh process, so its draws start again from the seed in every case, while the host engine's draws run on across its cases. The clock is pinned in ViperJS only; the host and plain Node engines read the real time.

Each case runs in a fresh engine and the answer is compared outside JavaScript, so a delivery that rewrites built-ins cannot pass, and an object, even one that converts to the answer, fails. The same spec and delivery give the same verdict on any machine. `judge` passes only when every case passes, and the verdict lists `cases` with the failures and `engine` with the sha256 of the module and the ViperJS commit it was built from. `judge` refuses a module whose sha256 differs from the one it pins; `scripts/viper-judge.sh` in this repository rebuilds it and checks that hash.

A delivery can tell that it runs in ViperJS, which has no `Intl` or `WebAssembly`, and answer correctly only there. So `judge` runs every case a second time in another engine, the host engine: a fresh V8 context in a separate Node process with the JavaScript built-ins, `Intl` included, but no `require`, `eval` or imports, no environment, and no file access. Next to plain Node, the host engine lacks exactly these globals: `AbortController`, `AbortSignal`, `Blob`, `BroadcastChannel`, `Buffer`, `ByteLengthQueuingStrategy`, `CompressionStream`, `CountQueuingStrategy`, `Crypto`, `CryptoKey`, `CustomEvent`, `DOMException`, `DecompressionStream`, `Event`, `EventTarget`, `File`, `FormData`, `Headers`, `MessageChannel`, `MessageEvent`, `MessagePort`, `Navigator`, `Performance`, `PerformanceEntry`, `PerformanceMark`, `PerformanceMeasure`, `PerformanceObserver`, `PerformanceObserverEntryList`, `PerformanceResourceTiming`, `ReadableByteStreamController`, `ReadableStream`, `ReadableStreamBYOBReader`, `ReadableStreamBYOBRequest`, `ReadableStreamDefaultController`, `ReadableStreamDefaultReader`, `Request`, `Response`, `SubtleCrypto`, `TextDecoder`, `TextDecoderStream`, `TextEncoder`, `TextEncoderStream`, `TransformStream`, `TransformStreamDefaultController`, `URL`, `URLSearchParams`, `WebSocket`, `WritableStream`, `WritableStreamDefaultController`, `WritableStreamDefaultWriter`, `atob`, `btoa`, `clearImmediate`, `clearInterval`, `clearTimeout`, `crypto`, `fetch`, `global`, `navigator`, `performance`, `process`, `queueMicrotask`, `setImmediate`, `setInterval`, `setTimeout` and `structuredClone`. The host engine also adds exactly these globals, through which it calls the delivery: `__call` and `__json`. Both ViperJS and the host engine leave `import.meta.url` undefined, where plain Node gives a module the `file:` URL it was loaded from. `judge` passes only when both engines answer every case, and the verdict lists the second run as `host`. A delivery that behaves differently when it detects one of the two fails in the other, but both differ from plain Node in the same ways, so a delivery can recognise any judge, for example by `import.meta.url`, and answer correctly only there. `--plain-node`, below, adds plain Node as a third engine.

A pass proves that the delivery answered every case in the engines that ran, and no more. The cases are public, so a delivery can answer them from a table: list many cases, including the edge cases a wrong algorithm would get wrong, as the word count spec does for whitespace. A committee whose members each judge with cases of their own, such as cases the spec does not publish or answers compared with a reference on generated inputs, catches a table where one judge would not. With `OWNER` and `NONCE` from step 2, judge the word count example this way:

```sh
intent-engine judge --owner $OWNER --nonce $NONCE --spec examples/jobs/word-count/SPEC.md --artifact examples/jobs/word-count/delivery/wordcount.mjs --sandbox viper --verdict verdict.json
intent-engine judge --owner $OWNER --nonce $NONCE --spec examples/jobs/word-count/SPEC.md --artifact examples/jobs/word-count/delivery/wordcount.mjs --sandbox viper --verdict verdict.json --yes
```

In PowerShell:

```powershell
intent-engine judge --owner $env:OWNER --nonce $env:NONCE --spec examples/jobs/word-count/SPEC.md --artifact examples/jobs/word-count/delivery/wordcount.mjs --sandbox viper --verdict verdict.json
intent-engine judge --owner $env:OWNER --nonce $env:NONCE --spec examples/jobs/word-count/SPEC.md --artifact examples/jobs/word-count/delivery/wordcount.mjs --sandbox viper --verdict verdict.json --yes
```

### Judge in plain Node too

`judge --sandbox viper --plain-node` also runs every case in plain Node inside a Docker container. It needs Docker: `judge` checks Docker and pulls the image before it runs anything, as `--sandbox docker` does, and refuses with the same refusals. The container starts from the image `--sandbox-image` names, by default the same pinned image as `--sandbox docker`, and takes `--sandbox-memory` and `--sandbox-cpus` as there. With `--sandbox viper` these three options are accepted only together with `--plain-node`, and `judge` refuses `--plain-node` with any sandbox other than `viper`. The container:

- has no network, a read-only root filesystem, no Linux capabilities and no way to gain privileges, and the same process cap and user 65534 as `--sandbox docker`;
- has no writable `/tmp` and no shared memory, and an empty read-only `/dev/mqueue`;
- sees one read-only mount, `/judge`, that holds the delivery and the judge's runner and nothing else from your machine;
- holds the delivery at `/judge/<random>/<name>.mjs`, in a directory named afresh for each judgement, and loads it with a real `import()` of its `file:` URL, so `import.meta.url`, `import.meta.resolve`, `process`, `console`, timers and every other Node global are what plain Node gives a module.

Each case runs in a fresh Node process, started by a launcher that never loads the delivery and that kills every other process in the container after each case. Before it imports the delivery, the case process reads the case's arguments and a fresh random token from its standard input and keeps its own references to what it needs to answer; it then writes the answer framed by that token. `judge`, outside the container, accepts only an answer framed by the case's token and compares it with the expected answer itself. A case with no framed answer, two framed answers, an answer that is not a string, number, boolean or null, an exception, or no answer in time fails, so a delivery that writes to stdout or stderr, exits early, patches built-ins or prototypes, or reads the runner's files gains no way to pass a case it answers wrongly. The time each case may take is `NODE_CASE_MS` in `packages/cli/src/node-judge.ts`.

The verdict lists this run as `node`, beside `cases` and `host`: `{ "engine": "node-docker", "image", "path", "total", "passed", "failures" }`, where `path` is the delivery's path inside the container. `judge` passes only when every engine it ran answered every case. Without `--plain-node` nothing changes: no Docker is needed and the verdict has no `node`.

`--timeout` bounds the whole judgement, not each engine: the engines share one deadline, and an engine that starts with less than `--timeout` left gets only what is left. An engine stopped by the deadline fails its unfinished cases as `stopped`.

A pass still proves behaviour only in the engines that ran. A delivery can detect every judge engine, the plain Node one included, for example by the container's paths, its user, the missing network or the read-only files, and behave differently elsewhere; `--plain-node` closes only the difference between the judge and plain Node itself. Use `--plain-node` for escrows whose work will run in Node. With `OWNER` and `NONCE` from step 2:

```sh
intent-engine judge --owner $OWNER --nonce $NONCE --spec examples/jobs/word-count/SPEC.md --artifact examples/jobs/word-count/delivery/wordcount.mjs --sandbox viper --plain-node --verdict verdict.json
```

In PowerShell:

```powershell
intent-engine judge --owner $env:OWNER --nonce $env:NONCE --spec examples/jobs/word-count/SPEC.md --artifact examples/jobs/word-count/delivery/wordcount.mjs --sandbox viper --plain-node --verdict verdict.json
```

## Who is paid

Anyone can copy a delivery announcement once it is on chain, so `judge` pays the earliest announcer of the work's hash: the announcement in the lowest slot, and of those the lowest signature. It refuses when nobody announced the hash. It reads your wallet's history back to the escrow's creation, at most `--max-pages` pages of 1000 transactions (default 100, at most 100000), and refuses before running anything when that record is incomplete, with or without `--pay-to`. `judge` and `deliveries` read 100 pages by default, while the MCP tools `solive_wallet_attest` and `solive_wallet_attest_split` read up to their `max_pages`, default 1000; a history between those lengths stops the CLI until you raise `--max-pages`, but not the MCP tools. It is incomplete when the history is longer than `--max-pages` pages, which a higher `--max-pages` fixes; when the RPC node's ledger, from its first available slot, does not reach back to the escrow's creation; or when the node cannot page signatures or report its first available slot. More pages do not fix the last two; use an RPC node that keeps the full ledger. The refusal says how many pages it read. `--pay-to` pays a wallet of your choice only when nobody announced the hash, or when that wallet is its earliest announcer; otherwise `judge` refuses.

## The work's hash

A file hashes as the SHA-256 of its bytes, so its name does not matter and any sha256 tool gives the same hash. A directory hashes as `manifestSha256` over every file under it, by its path relative to the directory with forward slashes, skipping `.git`, `node_modules` and `target`. `judge` refuses work that holds a symbolic link or any other entry that is neither a file nor a directory. A worker announces this hash, which `intent-engine hash --artifact <file or directory>` prints on every platform; `intent-engine deliver --artifact <file or directory>` announces the same hash without copying it. `judge`, `hash` and `deliver` refuse, before reading the contents of any file, a file larger than 67108864 bytes, a directory whose files add up to more than that, or a directory of more than 10000 files; nothing is run or paid. Work that is one file links to that file itself; work that is several files links to an archive, which the judge unpacks into a directory before it judges it.

## From an AI agent

An MCP server started with `--wallet` lists the same deliveries with `solive_wallet_check_delivery` and releases with `solive_wallet_attest`, which needs `delivered_sha256` for a proof escrow and refuses one that another wallet than `pay_to` announced first, or that it cannot check because the record is incomplete for one of the reasons above. `solive_wallet_attest_split` needs `delivered_sha256` too and refuses a split whose recipients leave out that work's earliest announcer. It records the same memo in the release when it fits; otherwise it sends the release without it and then, in a second transaction it signs, the memo `delivery sha256:<artifactSha256> release:<release signature>`. Its `recorded` says which, `release` or `follow-up`, with the `follow_up_signature`, and `solive_wallet_receipt` reads both, counting a memo in the release only when the attestor signed it. When the follow-up fails, `recorded` is `false` and `record_memo` holds the memo; `solive_wallet_record_delivery`, or `record-delivery` with the judge's keypair, sends it from the same wallet with a zero transfer to the escrow, once it has checked that the release is that wallet's and records no hash yet. Pass the release's signature as `release`, or `--release`: both then read the release from that transaction, and they work after the escrow is closed, reading its attestor, spec hash and creation time from the transaction that made it. They refuse when the record of announced work is incomplete and name the cause. A split's recipients are read from its split instruction for this escrow, also when another program made the call; when no such instruction is found, the refusal asks for the recipients. Neither runs or fetches anything, so run the check with `judge` or on your own.

## Judge as a committee

One judge is one point of failure: a bribe, a mistake, or a delivery that passes the published cases without doing the work. An escrow can name a committee instead, so any `threshold` of its members must agree before it pays. A committee lives at an address derived from its members, threshold and fee wallet, so it cannot change after an escrow names it.

```powershell
intent-engine committee create --keypair payer.json --members $env:A,$env:B,$env:C --threshold 2 --fee-wallet $env:FEES --yes
```

Pass the printed `committee` address as `--attestor` when you create the proof escrow. Workers announce to that address as they would to one judge. Each member judges on their own; when a member's `judge` run passes, the verdict file carries that member's signed vote instead of a release:

```powershell
intent-engine judge --keypair a.json --owner $env:OWNER --nonce $env:NONCE --spec SPEC.md --artifact work.mjs --sandbox viper --verdict a.json.verdict
```

A member who judges another way, by reading the work or with a check of their own, signs with `committee vote --keypair <member> --owner --nonce --pay-to --result --out <file> --yes`. Any member who voted then submits the threshold of votes, recording the work's hash in a memo it signs:

```powershell
intent-engine committee release --keypair a.json --vote a.json.verdict --vote b.json.verdict --sha256 $env:WORK --yes
```

Anyone can submit the votes without `--sha256`, but a receipt counts the recorded hash only from a member who voted for that release.

`committee release` checks every vote against the escrow before it sends, and the program checks them again: every vote must sign the same escrow, payee and result, and the release needs at least `threshold` members. The judge fee goes to the committee's fee wallet. `committee show --committee <address>` prints its terms. Members who run different checks cover each other's blind spots; members who all run the same check do not.

## Job claims

Without claims, every worker races on the same job and only the first announcer is paid. The owner can open claims on a proof escrow instead: a worker then holds the job for a while against a stake, and while the claim holds, only that worker can be paid. Every command previews until you add `--yes`.

The owner opens claims, naming the longest a claim may run, in seconds, and the stake in SOL:

```powershell
intent-engine claims open --keypair owner.json --nonce $env:NONCE --max-secs 7200 --stake 0.05 --yes
```

A worker reads the board and takes the job for as long as it needs, up to that maximum and never past the escrow's expiry. `claims take` refuses before it sends anything while another worker holds the claim, and names the holder and the seconds left:

```powershell
intent-engine claims show --owner $env:OWNER --nonce $env:NONCE
intent-engine claims take --keypair worker.json --owner $env:OWNER --nonce $env:NONCE --secs 3600 --yes
```

A worker that cannot finish gives the job up with `claims drop` and gets its stake back. Every other worker may take the job at once; the worker that dropped it may take it again only once the claim it dropped would have ended, so dropping and claiming again never extends a hold. Once the escrow is released, cancelled or expired, anyone settles the board with `claims settle --keypair <payer file> --owner --nonce`, which closes it and returns its rent to the owner; while the escrow is open, it only ends a lapsed claim.

Who gets the stake:

- A release that pays the claimant returns its stake to it.
- A worker that drops its claim gets its stake back.
- A claim that lapses forfeits its stake to the owner, when the next worker takes the job, when the release pays someone else, when the owner cancels, or when anyone settles the board.
- A claim that still holds when the owner cancels the escrow is refunded to its worker by the cancel itself, so waiting for the claim to lapse after a cancel gains the owner nothing. A claim never outlives the escrow, so at expiry it has lapsed.

An MCP agent reads the board with `solive_get_claims` and takes or drops a claim with `solive_wallet_claim`, which previews until called with `send: true` and the approval its preview returned.

## Next

- [Reputation](reputation.md)
- [CLI reference](reference/cli.md)
- [MCP tools](reference/mcp-tools.md)
- [Build on it from TypeScript](sdk.md)
