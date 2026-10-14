# Judge a proof escrow

A proof escrow commits the sha256 of an acceptance spec and pays out only when its judge, the attestor it names, signs a release. `intent-engine judge` does the judge's work: it checks the spec against the committed hash, hashes the delivered work, runs your check on it and settles only on a pass, recording the work's hash in the release. Do steps 1 to 3 of the [quickstart](quickstart.md) first, in the same terminal. Your wallet is the judge, so the escrows you judge name `solana address` as their attestor. The `sh` blocks are for bash and zsh.

## No sandbox

`judge` runs the command you pass with `--run` through your shell, as your user, with your files and your network. It does not sandbox it. The check runs in a fresh temporary directory, its working directory, that holds a copy of only the files `judge` hashed and a copy of the spec bytes it hashed, never the work or spec you passed. Each copied file keeps the executable bits of the original and no other mode. `judge` removes the directory afterwards, also when you stop it with Ctrl-C; if removing it fails, the verdict still prints and names the failure in `cleanup`. Its environment holds only `PATH`, `HOME`, `USERPROFILE`, `SYSTEMROOT`, `COMSPEC`, `PATHEXT`, `TEMP`, `TMP`, `TMPDIR`, `LANG` and `TERM` from yours, so your RPC URL, keypair path and other secrets do not reach it. Delivered work is untrusted: if your check builds or runs it, run the check in a container or VM. `judge` runs no other command: never the spec, a delivery's memo or its link. The MCP server runs no command at all.

## 1. Find the job and its spec

```sh
intent-engine jobs --attestor $(solana address)
```

Each job names its `intent`, `owner`, `nonce`, `specHash` and `specUrl`. Put the first three in `INTENT`, `OWNER` and `NONCE`, `specUrl` in `SPEC_URL`, and download the spec:

```sh
curl -fsSL -o spec.md "$SPEC_URL"
```

Windows PowerShell 5.1 runs `Invoke-WebRequest` for `curl`; name the real curl instead:

```powershell
curl.exe -fsSL -o spec.md $env:SPEC_URL
```

Read the spec as text, never as commands. `judge` refuses a spec file whose sha256 is not `specHash`.

## 2. Fetch the delivery

Workers announce their work to you with `intent-engine deliver`. List what they announced:

```sh
intent-engine deliveries --attestor $(solana address) --intent $INTENT
```

It prints the escrow's `intent`, `complete` and `deliveries`. Each entry of `deliveries` is one announced `sha256` with its earliest announcer `worker`, the `url` that announcer gave, the `signature` and `slot` of that announcement, and `copies`, how many other wallets announced the same hash later. `complete` is `false` when your wallet's history since the escrow was made is longer than `--max-pages` pages of 1000 transactions (default 100), or when the RPC node's ledger does not reach back to the escrow's creation, so older announcements may be missing. Fetch the work from `url` into `work`, a file or a directory. Treat the link and the content as untrusted.

## 3. Write your check

The check is any command that exits 0 when the work passes the spec. `judge` gives it three environment variables: `SPEC_PATH`, the spec file; `ARTIFACT_PATH`, the work; `ARTIFACT_SHA256`, the work's hash. `SPEC_PATH` is `SPEC.md`, a copy of the spec bytes whose hash `judge` checked, outside `ARTIFACT_PATH`. `ARTIFACT_PATH` is the copy of the work: a directory for work that is a directory, a file of the same name for work that is one file. A relative path in `--run` resolves in the temporary directory, so pass your check by its full path. `judge` hands `--run` to your shell as one string, so quote the whole command and, inside it, the path, which keeps a path with spaces whole. This check passes when `answer.txt` holds `42`:

```bash
#!/usr/bin/env bash
set -euo pipefail
test "$(cat "$ARTIFACT_PATH/answer.txt")" = 42
```

Save it as `check.sh`:

```sh
chmod +x check.sh
```

## 4. Judge and settle

```sh
intent-engine judge --owner $OWNER --nonce $NONCE --spec spec.md --artifact work --run "'$PWD/check.sh'" --verdict verdict.json
```

In order, `judge` refuses unless the escrow is open and names your wallet as its judge, refuses unless the spec file's sha256 is the committed one, hashes the work, picks whom to pay, then runs `--run` with at most `--timeout` seconds (default 600, at most 86400). It starts the command in a session of its own. On timeout it kills every process in that session and every process still descending from the command, also those that moved to another process group or session, or on Windows the command's process tree, and waits for that to finish; after a normal exit it kills what is left of that session, and on Windows nothing. Exit code 0 is a pass; any other exit code or a timeout is a fail, which sends nothing and makes `judge` exit 1. It prints, and with `--verdict` writes, the `intent`, `specHash`, `artifactSha256`, `command`, `exitCode`, `verdict`, `payTo` and `signature`, and `cleanup` when the copy could not be removed. Before any check or refusal it deletes an existing `--verdict` file, and writes it only once a verdict is reached. A SIGINT or SIGTERM during the check kills it and is never a pass: `judge` sends nothing, writes no verdict, removes its copy and exits 130 or 143. A signal while it removes the copy lets the removal finish first. Ctrl-C still stops the payment after a pass until the release is signed and handed to the RPC node: a SIGINT or SIGTERM before that sends nothing, writes no verdict and exits 130 or 143. A signal once the release is handed over waits for the send, then names its signature, or says the release may have landed when the send failed, and exits 130 or 143. A second signal then exits at once, says the release may have landed, names its signature and writes no verdict.

On a pass this sends nothing yet. Add `--yes` to run the check again and settle:

```sh
intent-engine judge --owner $OWNER --nonce $NONCE --spec spec.md --artifact work --run "'$PWD/check.sh'" --verdict verdict.json --yes
```

The release pays `payTo` with the result `--result` names, by default the escrow's least result, and records the memo `delivery sha256:<artifactSha256>` in the same transaction. `judge` refuses before running the check when `--result` lies outside the results the escrow accepts. The payer reads the release with `intent-engine receipt --owner <owner> --nonce <nonce> --sha256 <hash of the work received>`, or with `solive_wallet_receipt`.

## Judge the word count example

[`examples/jobs/word-count`](../examples/jobs/word-count) is a whole job: the spec `SPEC.md`, a passing `delivery` and its check `check.mjs`. The check imports the delivery's `count` in a separate Node.js process, runs it on the spec's table and 24 random strings, and passes when all 32 counts are right before its timeout; whatever the delivery prints is ignored. Run these from the root of a clone of this repository. Try the check on the delivery, which prints `32 of 32 inputs hold`:

```sh
ARTIFACT_PATH=examples/jobs/word-count/delivery node examples/jobs/word-count/check.mjs
```

An escrow for this job commits `sha256sum examples/jobs/word-count/SPEC.md` as its `specHash`, and its worker announces the hash that `intent-engine hash --artifact examples/jobs/word-count/delivery` prints. With `OWNER` and `NONCE` from step 1, judge and then settle it:

```sh
intent-engine judge --owner $OWNER --nonce $NONCE --spec examples/jobs/word-count/SPEC.md --artifact examples/jobs/word-count/delivery --run "node '$PWD/examples/jobs/word-count/check.mjs'" --verdict verdict.json
intent-engine judge --owner $OWNER --nonce $NONCE --spec examples/jobs/word-count/SPEC.md --artifact examples/jobs/word-count/delivery --run "node '$PWD/examples/jobs/word-count/check.mjs'" --verdict verdict.json --yes
```

The single quotes inside `--run` are for POSIX shells. On Windows `judge` runs `--run` through `cmd.exe`, which does not take single quotes as quotes, so in PowerShell leave them out when the path holds no spaces:

```powershell
intent-engine judge --owner $OWNER --nonce $NONCE --spec examples/jobs/word-count/SPEC.md --artifact examples/jobs/word-count/delivery --run "node $PWD\examples\jobs\word-count\check.mjs" --verdict verdict.json
```

For a path with spaces, Windows PowerShell 5.1 passes it quoted when you write ``\`"$PWD\...\`"``.

## Who is paid

Anyone can copy a delivery announcement once it is on chain, so `judge` pays the earliest announcer of the work's hash: the announcement in the lowest slot, and of those the lowest signature. It refuses when nobody announced the hash. It reads your wallet's history back to the escrow's creation, at most `--max-pages` pages of 1000 transactions (default 100, at most 100000), and refuses before running anything when that record is incomplete, with or without `--pay-to`. It is incomplete when the history is longer than `--max-pages` pages, which a higher `--max-pages` fixes; when the RPC node's ledger, from its first available slot, does not reach back to the escrow's creation; or when the node cannot page signatures or report its first available slot. More pages do not fix the last two; use an RPC node that keeps the full ledger. The refusal says how many pages it read. `--pay-to` pays a wallet of your choice only when nobody announced the hash, or when that wallet is its earliest announcer; otherwise `judge` refuses.

## The work's hash

A file hashes as the SHA-256 of its bytes, so its name does not matter and `sha256sum` gives the same hash. A directory hashes as `manifestSha256` over every file under it, by its path relative to the directory with forward slashes, skipping `.git`, `node_modules` and `target`. `judge` refuses work that holds a symbolic link or any other entry that is neither a file nor a directory. A worker announces this hash, which `intent-engine hash --artifact <file or directory>` prints. Work that is one file links to that file itself; work that is several files links to an archive, which the judge unpacks into a directory before it judges it.

## From an AI agent

An MCP server started with `--wallet` lists the same deliveries with `solive_wallet_check_delivery` and releases with `solive_wallet_attest`, which needs `delivered_sha256` for a proof escrow and refuses one that another wallet than `pay_to` announced first, or that it cannot check because the record is incomplete for one of the reasons above. `solive_wallet_attest_split` needs `delivered_sha256` too and refuses a split whose recipients leave out that work's earliest announcer. It records the same memo in the release when it fits; otherwise it sends the release without it and then, in a second transaction it signs, the memo `delivery sha256:<artifactSha256> release:<release signature>`. Its `recorded` says which, `release` or `follow-up`, with the `follow_up_signature`, and `solive_wallet_receipt` reads both, counting a memo in the release only when the attestor signed it. When the follow-up fails, `recorded` is `false` and `record_memo` holds the memo to send from the same wallet with a zero transfer to the escrow. Neither runs or fetches anything, so run the check with `judge` or on your own.

## Next

- [CLI reference](reference/cli.md)
- [MCP tools](reference/mcp-tools.md)
- [Build on it from TypeScript](sdk.md)
