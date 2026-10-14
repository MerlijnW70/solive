# Judge a proof escrow

A proof escrow commits the sha256 of an acceptance spec and pays out only when its judge, the attestor it names, signs a release. `intent-engine judge` does the judge's work: it checks the spec against the committed hash, hashes the delivered work, runs your check on it and settles only on a pass, recording the work's hash in the release. Do steps 1 to 4 of the [quickstart](quickstart.md) first, in the same terminal. Your wallet is the judge, so the escrows you judge name `solana address` as their attestor. The `sh` blocks are for bash and zsh and the `powershell` blocks for Windows PowerShell; a command without a `powershell` block runs unchanged in both. The guide keeps values in variables: in bash and zsh as shell variables such as `$OWNER`, in PowerShell as environment variables such as `$env:OWNER`.

## No sandbox

`judge` runs the command you pass with `--run` through your shell, as your user, with your files and your network. It does not sandbox it. The check runs in a fresh temporary directory, its working directory, that holds a copy of only the files `judge` hashed and a copy of the spec bytes it hashed, never the work or spec you passed. Each copied file keeps the executable bits of the original and no other mode. `judge` removes the directory afterwards, also when you stop it with Ctrl-C; if removing it fails, the verdict still prints and names the failure in `cleanup`. Its environment holds only `PATH`, `HOME`, `USERPROFILE`, `SYSTEMROOT`, `COMSPEC`, `PATHEXT`, `TEMP`, `TMP`, `TMPDIR`, `LANG` and `TERM` from yours, so your RPC URL, keypair path and other secrets do not reach it. Delivered work is untrusted: if your check builds or runs it, run the check in a container or VM. `judge` runs no other command: never the spec, a delivery's memo or its link. The MCP server runs no command at all.

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

The check is any command that exits 0 when the work passes the spec. `judge` gives it three environment variables: `SPEC_PATH`, the spec file; `ARTIFACT_PATH`, the work; `ARTIFACT_SHA256`, the work's hash. `SPEC_PATH` is `SPEC.md`, a copy of the spec bytes whose hash `judge` checked, outside `ARTIFACT_PATH`. `ARTIFACT_PATH` is the copy of the work: a directory for work that is a directory, a file of the same name for work that is one file. A relative path in `--run` resolves in the temporary directory, so pass your check by its full path. `judge` hands `--run` to your shell as one string, so quote the whole command and, inside it, the path, which keeps a path with spaces whole. This check passes when `answer.txt` holds `42`. It is a Node.js script, so `node` runs it on Linux, macOS and Windows alike:

```js
import { readFileSync } from "node:fs";
import { join } from "node:path";

const answer = readFileSync(join(process.env.ARTIFACT_PATH, "answer.txt"), "utf8");
process.exit(answer.trim() === "42" ? 0 : 1);
```

Save it as `check.mjs`. On Linux and macOS a bash script can do the same:

```bash
#!/usr/bin/env bash
set -euo pipefail
test "$(cat "$ARTIFACT_PATH/answer.txt")" = 42
```

Save it as `check.sh`, make it executable and pass `--run "'$PWD/check.sh'"` in place of the `node` command in step 5:

```sh
chmod +x check.sh
```

On Windows `judge` runs `--run` through `cmd.exe`, which runs neither a bash script nor `chmod`, so use the Node.js check there.

## 5. Judge and settle

```sh
intent-engine judge --owner $OWNER --nonce $NONCE --spec spec.md --artifact work --run "node '$PWD/check.mjs'" --verdict verdict.json
```

The single quotes inside `--run` are for POSIX shells. On Windows `judge` runs `--run` through `cmd.exe`, which does not take single quotes as quotes, so in PowerShell leave them out when the path holds no spaces:

```powershell
intent-engine judge --owner $env:OWNER --nonce $env:NONCE --spec spec.md --artifact work --run "node $PWD\check.mjs" --verdict verdict.json
```

For a path with spaces, Windows PowerShell 5.1 passes it quoted when you write ``\`"$PWD\...\`"``.

In order, `judge` refuses unless the escrow is open and names your wallet as its judge, refuses unless the spec file's sha256 is the committed one, hashes the work, picks whom to pay, then runs `--run` with at most `--timeout` seconds (default 600, at most 86400). It starts the command in a session of its own. While the command runs, `judge` records every process in that session, in its process groups or descending from it, each by its PID and start time. On timeout it kills every recorded process and every process descending from one, also those that moved to another process group or session, or on Windows the command's process tree, and waits for that to finish; after a normal exit it kills what is left of them, and on Windows nothing. It never kills by a session or group ID once the process that led it is gone, so a process that later reuses a PID is spared; a process the check started after it began in a session one of its processes created is still killed. A process it cannot tie to the check that still runs in its directory or with its `SPEC_PATH` is named in a warning on stderr and left running. Exit code 0 is a pass; any other exit code or a timeout is a fail, which sends nothing and makes `judge` exit 1. It prints, and with `--verdict` writes, the `intent`, `specHash`, `artifactSha256`, `command`, `exitCode`, `verdict`, `payTo` and `signature`, and `cleanup` when the copy could not be removed. Before any check or refusal it deletes an existing `--verdict` file, and writes it only once a verdict is reached. A SIGINT or SIGTERM during the check kills it and is never a pass: `judge` sends nothing, writes no verdict, removes its copy and exits 130 or 143. A signal while it removes the copy lets the removal finish first. Ctrl-C still stops the payment after a pass until the release is signed and handed to the RPC node: a SIGINT or SIGTERM before that sends nothing, writes no verdict and exits 130 or 143. A signal once the release is handed over waits for the send, then names its signature, or says the release may have landed when the send failed, and exits 130 or 143. A second signal then exits at once, says the release may have landed, names its signature and writes no verdict. Once the release is confirmed, a signal no longer stops anything: `judge` writes the verdict, names the signature and then exits 130 or 143.

On a pass this sends nothing yet. Add `--yes` to run the check again and settle:

```sh
intent-engine judge --owner $OWNER --nonce $NONCE --spec spec.md --artifact work --run "node '$PWD/check.mjs'" --verdict verdict.json --yes
```

In PowerShell:

```powershell
intent-engine judge --owner $env:OWNER --nonce $env:NONCE --spec spec.md --artifact work --run "node $PWD\check.mjs" --verdict verdict.json --yes
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

Its worker announces the plain sha256 of the file, the hash that `intent-engine hash --artifact examples/jobs/word-count/delivery/wordcount.mjs` prints. With `OWNER` and `NONCE` from step 2, judge and then settle it:

```sh
intent-engine judge --owner $OWNER --nonce $NONCE --spec examples/jobs/word-count/SPEC.md --artifact examples/jobs/word-count/delivery/wordcount.mjs --run "node '$PWD/examples/jobs/word-count/check.mjs'" --verdict verdict.json
intent-engine judge --owner $OWNER --nonce $NONCE --spec examples/jobs/word-count/SPEC.md --artifact examples/jobs/word-count/delivery/wordcount.mjs --run "node '$PWD/examples/jobs/word-count/check.mjs'" --verdict verdict.json --yes
```

In PowerShell:

```powershell
intent-engine judge --owner $env:OWNER --nonce $env:NONCE --spec examples/jobs/word-count/SPEC.md --artifact examples/jobs/word-count/delivery/wordcount.mjs --run "node $PWD\examples\jobs\word-count\check.mjs" --verdict verdict.json
intent-engine judge --owner $env:OWNER --nonce $env:NONCE --spec examples/jobs/word-count/SPEC.md --artifact examples/jobs/word-count/delivery/wordcount.mjs --run "node $PWD\examples\jobs\word-count\check.mjs" --verdict verdict.json --yes
```

## Who is paid

Anyone can copy a delivery announcement once it is on chain, so `judge` pays the earliest announcer of the work's hash: the announcement in the lowest slot, and of those the lowest signature. It refuses when nobody announced the hash. It reads your wallet's history back to the escrow's creation, at most `--max-pages` pages of 1000 transactions (default 100, at most 100000), and refuses before running anything when that record is incomplete, with or without `--pay-to`. `judge` and `deliveries` read 100 pages by default, while the MCP tools `solive_wallet_attest` and `solive_wallet_attest_split` read up to their `max_pages`, default 1000; a history between those lengths stops the CLI until you raise `--max-pages`, but not the MCP tools. It is incomplete when the history is longer than `--max-pages` pages, which a higher `--max-pages` fixes; when the RPC node's ledger, from its first available slot, does not reach back to the escrow's creation; or when the node cannot page signatures or report its first available slot. More pages do not fix the last two; use an RPC node that keeps the full ledger. The refusal says how many pages it read. `--pay-to` pays a wallet of your choice only when nobody announced the hash, or when that wallet is its earliest announcer; otherwise `judge` refuses.

## The work's hash

A file hashes as the SHA-256 of its bytes, so its name does not matter and any sha256 tool gives the same hash. A directory hashes as `manifestSha256` over every file under it, by its path relative to the directory with forward slashes, skipping `.git`, `node_modules` and `target`. `judge` refuses work that holds a symbolic link or any other entry that is neither a file nor a directory. A worker announces this hash, which `intent-engine hash --artifact <file or directory>` prints on every platform. Work that is one file links to that file itself; work that is several files links to an archive, which the judge unpacks into a directory before it judges it.

## From an AI agent

An MCP server started with `--wallet` lists the same deliveries with `solive_wallet_check_delivery` and releases with `solive_wallet_attest`, which needs `delivered_sha256` for a proof escrow and refuses one that another wallet than `pay_to` announced first, or that it cannot check because the record is incomplete for one of the reasons above. `solive_wallet_attest_split` needs `delivered_sha256` too and refuses a split whose recipients leave out that work's earliest announcer. It records the same memo in the release when it fits; otherwise it sends the release without it and then, in a second transaction it signs, the memo `delivery sha256:<artifactSha256> release:<release signature>`. Its `recorded` says which, `release` or `follow-up`, with the `follow_up_signature`, and `solive_wallet_receipt` reads both, counting a memo in the release only when the attestor signed it. When the follow-up fails, `recorded` is `false` and `record_memo` holds the memo; `solive_wallet_record_delivery`, or `record-delivery` with the judge's keypair, sends it from the same wallet with a zero transfer to the escrow, once it has checked that the release is that wallet's and records no hash yet. Pass the release's signature as `release`, or `--release`: both then read the release from that transaction, and they work after the escrow is closed, reading its attestor, spec hash and creation time from the transaction that made it. They refuse when the record of announced work is incomplete and name the cause. A split's recipients are read from its split instruction for this escrow, also when another program made the call; when no such instruction is found, the refusal asks for the recipients. Neither runs or fetches anything, so run the check with `judge` or on your own.

## Next

- [CLI reference](reference/cli.md)
- [MCP tools](reference/mcp-tools.md)
- [Build on it from TypeScript](sdk.md)
