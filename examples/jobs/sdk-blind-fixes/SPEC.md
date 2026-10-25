# Job: Fix what three first-time builders tripped over

Three agents who had never seen the SDK built a hiring script, a worker bot and a web page from the packed packages and the docs alone. All three got their apps working; these are the places they had to guess, read type files, or work around the SDK. Each item names what went wrong.

Read first: docs/sdk-client.md, docs/sdk.md, packages/client/src/testing.ts, first-opening.ts, announcement-reads.ts, jobs.ts, client.ts, client-types.ts, plan.ts, simple-work.ts, simple-reads.ts, simple-types.ts, job-specs.ts, public-host.ts, address-ranges.ts, scripts/pack-test.sh, and packages/client/package.json.

## Required

1. A program that judges can open deliveries without knowing the work's hash first. Today `firstOpening` needs the sha256 before it opens anything, and nothing exported opens an announcement without it, so a judge cannot do "open the earliest delivery, fetch it, hash it, decide". Add `client.openings({ intent, keypair? })`, which walks the announcements in seq order like `firstOpening` (same completeness rule, same skips and refusals for keys) and returns, for each one up to and including the first that opens with the caller's keys, its address, seq, worker, salt and work url. A judge fetches the url, hashes the work, and passes that hash to `firstOpening` and the settle call as today. The simple layer exposes the same; its `deliveries(...)` result says in its type and in the docs exactly what each field means, and `opened` is renamed or redefined so a judge holding only its key is never left waiting on a field that needs the hash it does not have.
2. The test world lets an app use local spec and work urls. A world built by `createTestWorld` reaches no network, so the urls its own clients create, fetch and announce may be plain-http loopback urls; every refusal that exists for a real cluster stays for real clusters. The world documents its `url` and `domain` options or drops the ones nobody needs.
3. Job listings tell a worker what it earns. Rename the job's `fee` to `judgeFee`, and add `net`: what the worker receives if paid now, computed with the same fee rules a release uses (judge fee, protocol fee, partner fee). `client.jobs` takes every `JobFilter` field the simple layer takes.
4. Plans work with a wallet that only gives an address. docs/sdk-client.md shows planning with kit's `createNoopSigner` for the wallet address, compiling the plan into a transaction, having the wallet sign it, and sending it; it states whether the payer appears in `signers`, and the `Plan` type matches what the page shows (the page mentions `plan.intent`, which the type lacks).
5. Setup and money facts a builder needs, each in the docs and pinned by a test: the install line for testing (the `litesvm` peer and its version range); that a release pays SOL as wrapped SOL and how to unwrap it; that the worker pays the announcement's rent from its own wallet and gets it back later; what `escrowed` reads after a release; and how to hash a spec in a browser with web crypto.
6. The client works with every `@solana/kit` 8.x the peer range allows: pack-test also installs the newest 8.x and runs its checks against it.
7. The Testing section gains one runnable example that posts an escrow with a local spec url, lists it with `jobs`, reads it with `spec`, delivers from a worker, and judges with `openings` and `settleProof`; the docs tests run it.
8. Tests for each change.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Do not change the program or the Rust crates. Keep TypeScript files under about 500 lines.
- packages/cli, packages/solver and the API reports keep passing; update the reports with the repository's script and list every public API change in the report.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names: `cargo test --workspace`, `bash scripts/ts-test.sh`, `bash scripts/lint.sh` and `bash scripts/pack-test.sh` all pass.
2. A test judges a delivery on a test world knowing only the judge's key and the spec: it gets the work url from `openings`, fetches it from a local server, hashes it, and releases; a second test shows `openings` skipping a griefer's blob that does not open and refusing like `firstOpening` when a key is not given.
3. A test shows `jobs` reporting `net` equal to what the release then pays the worker.
4. A test fails when the judge makes the test world refuse a loopback spec url again, and another when the judge makes a real-cluster client accept one.
5. The new docs example runs in the docs tests.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
