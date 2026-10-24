# Job: See what the SDK does

An app on `@intent-engine/client` cannot see what the client does on the wire: which RPC calls it makes, how long they take, when it retries a rate-limited node, when a transaction is sent and when it confirms. When something is slow or fails, the builder has the final error and nothing else. This job adds hooks and a debug log, with secrets kept out of both.

Read first: packages/client/src/client.ts, client-types.ts (`ClientOptions`), rpc-transport.ts, rpc-retry.ts (`patiently`), confirmation.ts, svm.ts, testing.ts, pinned-fetch.ts, job-specs.ts, intent-notifications.ts, the CLI's global options (packages/cli/src/args.ts, arg-options.ts, main.ts) and docs/sdk-client.md.

## Required

1. `ClientOptions.hooks` takes optional callbacks, each called with one plain object:
   - `request` and `response` for every RPC method call, with the method name, an id shared by the pair, the attempt number, the duration, and on failure the error;
   - `retry` for every retry `patiently` makes, with the method, the attempt, the delay and why;
   - `send` when a transaction leaves the client, with its signature, payer, instruction count and `lastValidBlockHeight`;
   - `confirm` when it confirms, fails or expires, with the signature, the outcome, the slot when known and the time since `send`;
   - `fetch` for every spec or work url the client fetches, with the url as shown below, the status and the duration.
2. Hooks never change what the client does: a hook that throws or returns a rejected promise is caught, the client continues, and the error goes to `hooks.error` when given. Hooks run for clients built on the svm transport too, so a test world can observe them.
3. A url in any hook or log line shows only scheme, host and port, never a path, query or credentials, the same rule the multisig CLI applies to `--url`. No hook or log line ever contains a private key, a secret, a signature over a salt message, a revealed `esk` or content key, or a decrypted delivery url.
4. `ClientOptions.debug` (a function or `true`) writes one line per event, built from the same events as the hooks; `true` writes to `console.debug`. It is off by default.
5. The CLI's global `--debug` flag turns the debug log on and writes it to stderr, so JSON on stdout stays parseable; the MCP server takes the same flag and never writes the log to stdout.
6. docs/sdk-client.md gets a short "Observe" section with one runnable example that counts requests and prints each send and confirm on a test world; every new sentence is pinned by a test as the page's other sentences are.
7. Tests for each change.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Do not change the program or the Rust crates. Keep TypeScript files under about 500 lines.
- With no hooks and no debug option, the client makes the same calls in the same order as before.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names: `cargo test --workspace`, `bash scripts/ts-test.sh`, `bash scripts/lint.sh` and `bash scripts/pack-test.sh` all pass.
2. A test sends a transaction on a test world and gets `request`/`response` pairs, then `send`, then `confirm`, in that order, with matching ids and signatures.
3. A fake-transport test shows a rate-limited call firing `retry` with its delay before the call succeeds.
4. A test with a hook that throws on every event shows the same transaction landing and `hooks.error` receiving each throw.
5. A test runs an announce and a release with debug on and with a url that holds a path, a query and credentials, and fails if any output contains the worker's secret, the salt signature, the url's path, query or credentials, or the decrypted work url.
6. A CLI test runs a command with `--debug` and shows stdout is still valid JSON while stderr holds the log.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
