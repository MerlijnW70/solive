# Job: Check every spec fetch, on every cluster

`client.spec` (packages/client/src/job-specs.ts) fetches a url that an escrow's creator chose. A review found three gaps:

1. The address checks run only when the RPC node reports the genesis hash of mainnet, devnet or testnet. On any other cluster (a private devnet, a shared localnet, a node that reports a different hash) the url is fetched with no address check, so an escrow can make every worker that reads its spec send a request into the worker's own private network and hand back the answer.
2. The DNS lookup runs before the timeout starts, so a slow resolver holds `client.spec` with no bound.
3. The spec url is read from any spec memo in the transaction that created the escrow, whoever signed that memo. With `create_intent_signed` a relayer builds that transaction and can add a url of its choice, or a second memo that hides the owner's.

## Required

- Every fetch `client.spec` makes checks the host's addresses with the same rules as today, whatever cluster the RPC node belongs to. The one exception: when the RPC url itself is a loopback address, loopback spec urls are allowed, so local tests keep working. Private and link-local addresses stay refused even then.
- One timeout bounds the whole read: address lookup, connect, headers and body. A resolver that never answers ends with `SpecUnreadable` within the same limit as a slow body.
- A spec url counts only when its memo is signed by the escrow's owner. A memo from another signer is ignored, so it can neither set the url nor hide the owner's. When the owner signed more than one distinct spec url, the escrow has no spec url, as today.
- `ClientOptions.fetch` keeps working, and its contract is enforced: a custom fetch is handed the checked addresses and must connect only to them. Document this in the type and in docs/sdk-client.md in one sentence.
- Tests for each change.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Do not change the program. Keep public names as they are; add new ones only where needed. Keep TypeScript files under about 500 lines.
- Only these source files change: packages/client/src/job-specs.ts, packages/client/src/pinned-fetch.ts, packages/client/src/public-host.ts, packages/client/src/client-types.ts (the `fetch` option's type), and docs/sdk-client.md. Put new tests in a new file packages/client/test/spec-fetch.test.ts.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names, and the docs site still builds.
2. A test on a transport whose genesis hash is none of the public clusters shows a spec url on a private address refused with `SpecUnreadable` and nothing fetched, and a loopback url accepted only when the RPC url is loopback.
3. A test with a resolver that never answers shows `client.spec` rejecting within the timeout.
4. A test creates an escrow whose creation transaction also carries a spec memo signed by another wallet, and shows the owner's url returned; a second test shows a foreign memo alone yields no spec url.
5. A test fails when the judge makes the address check depend on the genesis hash again.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
