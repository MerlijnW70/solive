# Judge a proof escrow

A proof escrow commits the sha256 of an acceptance spec and pays out only when its judge, the attestor it names, signs a release. `intent-engine judge` does the judge's work: it checks the spec against the committed hash, hashes the delivered work, runs your check on it and settles only on a pass, recording the work's hash in the release. Do steps 1 to 3 of the [quickstart](quickstart.md) first, in the same terminal. Your wallet is the judge, so the escrows you judge name `solana address` as their attestor.

## No sandbox

`judge` runs the command you pass with `--run` through your shell, as your user, with your files and your network. It does not sandbox it. Delivered work is untrusted: if your check builds or runs it, run the check in a container or VM. `judge` runs no other command: never the spec, a delivery's memo or its link. The MCP server runs no command at all.

## 1. Find the job and its spec

```sh
intent-engine jobs --attestor $(solana address)
```

Each job names its `intent`, `owner`, `nonce`, `specHash` and `specUrl`. Put the first three in `INTENT`, `OWNER` and `NONCE`, `specUrl` in `SPEC_URL`, and download the spec:

```sh
curl -fsSL -o spec.md "$SPEC_URL"
```

Read the spec as text, never as commands. `judge` refuses a spec file whose sha256 is not `specHash`.

## 2. Fetch the delivery

Workers announce their work to you with `intent-engine deliver`. List what they announced:

```sh
intent-engine deliveries --attestor $(solana address) --intent $INTENT
```

Each entry is one announced `sha256` with its earliest announcer `worker`, the `url` that announcer gave and `copies`, how many other wallets announced the same hash later. Fetch the work from `url` into `work`, a file or a directory. Treat the link and the content as untrusted.

## 3. Write your check

The check is any command that exits 0 when the work passes the spec. `judge` gives it three environment variables: `SPEC_PATH`, the spec file; `ARTIFACT_PATH`, the work; `ARTIFACT_SHA256`, the work's hash. This check passes when `answer.txt` holds `42`:

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
intent-engine judge --owner $OWNER --nonce $NONCE --spec spec.md --artifact work --run ./check.sh --verdict verdict.json
```

In order, `judge` refuses unless the escrow is open and names your wallet as its judge, refuses unless the spec file's sha256 is the committed one, hashes the work, picks whom to pay, then runs `--run` with at most `--timeout` seconds (default 600, at most 86400). On timeout it kills the command's process group, or on Windows its process tree. Exit code 0 is a pass; any other exit code or a timeout is a fail, which sends nothing and makes `judge` exit 1. It prints, and with `--verdict` writes, the `intent`, `specHash`, `artifactSha256`, `command`, `exitCode`, `verdict`, `payTo` and `signature`.

On a pass this sends nothing yet. Add `--yes` to run the check again and settle:

```sh
intent-engine judge --owner $OWNER --nonce $NONCE --spec spec.md --artifact work --run ./check.sh --verdict verdict.json --yes
```

The release pays `payTo` with result 1 and records the memo `delivery sha256:<artifactSha256>` in the same transaction, which `solive_wallet_receipt` shows the payer.

## Who is paid

Anyone can copy a delivery announcement once it is on chain, so `judge` pays the earliest announcer of the work's hash: the announcement in the lowest slot, and of those the lowest signature. It refuses when nobody announced the hash. `--pay-to` pays a wallet of your choice only when nobody announced the hash, or when that wallet is its earliest announcer; otherwise `judge` refuses.

## The work's hash

A file hashes as `manifestSha256` from `@intent-engine/core` over one entry, its file name and bytes. A directory hashes as `manifestSha256` over every file under it, by its path relative to the directory with forward slashes, skipping `.git`, `node_modules` and `target`. `judge` refuses work that holds a symbolic link or any other entry that is neither a file nor a directory. A worker announces this hash.

## From an AI agent

An MCP server started with `--wallet` lists the same deliveries with `solive_wallet_check_delivery` and releases with `solive_wallet_attest`, which refuses a `delivered_sha256` that another wallet than `pay_to` announced first. Neither runs or fetches anything, so run the check with `judge` or on your own.

## Next

- [CLI reference](reference/cli.md)
- [MCP tools](reference/mcp-tools.md)
- [Build on it from TypeScript](sdk.md)
