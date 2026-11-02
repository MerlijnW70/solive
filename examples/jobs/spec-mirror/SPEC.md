# Job: A mirror that serves job specs by their hash (J3)

Readers can now find a spec by its hash (`packages/client/src/spec-sources.ts`, kind `mirror`: `GET {base}/sha256/{hex}`), but nothing publishes specs to any hash source, so a job whose url fails usually stays unreadable. Build the mirror as a new service. A research report is in `F:\solive-kit\kill-wave\spec-store-stack\report.md`.

## Build

1. **Service.** A new service folder named `specs` next to `services/faucet`, a Vercel Node function laid out like `services/faucet` (same test and build setup, added to the workspace and to `scripts/ci.sh` the way the faucet is). Bytes live in public Vercel Blob under `sha256/<hex>`, behind a small storage interface so tests use an in-memory store.
2. **Read.** `GET /sha256/{hex}` answers 200 with the exact bytes, `content-type: application/octet-stream`, `x-content-type-options: nosniff`, and a long immutable cache header; 404 when unknown; 400 for anything that is not 64 lowercase hex characters. `GET /ipfs/{cid}?format=raw` serves the same bytes for a CID accepted by `specHashOfCid`, and 400 otherwise.
3. **Write.** `PUT /sha256/{hex}` accepts a body only when all of these hold, checked in this order: the body is within the spec size cap readers use; its sha256 equals `{hex}`; the program holds an Open AttestedResult escrow with that `spec_hash`, found with one filtered `getProgramAccounts` on kind, status and the hash at its params offset. The answer is 201 when stored and 200 when already stored, without writing twice. There is no way to overwrite or delete through the service. Bytes already stored stay after the escrow closes.
4. **Limits.** A per-caller rate limit on PUT with `retry-after`, the same way `services/faucet/src/callers.ts` does it. A refused body is never written to storage. The node url comes from the environment and must be devnet for now, checked by genesis hash as the faucet does.
5. **Client wiring.** Nothing changes in `DEFAULT_SPEC_SOURCES` yet; that follows once the service is deployed. Document in a README in the new folder how to deploy it and how a reader adds it through `specSources`, in the repository's terse style.

## Tests

Each fails if its behaviour breaks: read returns the exact bytes and headers; unknown hash 404; bad hex and a bad CID 400; a CID and its hex serve the same bytes; PUT with wrong bytes, an oversize body, no matching escrow, a closed escrow, a non-attested kind each refused and nothing stored; a repeat PUT does not write again; the escrow lookup sends the kind, status and hash filters; the rate limit answers 429 with `retry-after`; a non-devnet node is refused; a real client built with `createClient` and this mirror as a source reads a spec whose memo url fails, end to end against the handler with a fake fetch.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- No program change. No change to published package exports. Tests never use the network.
- Reuse `specHashOfCid` from `packages/client`; no new production dependency beyond the Vercel Blob client.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
