# Job: A program-wide activity read in the SDK

Building the live feed under `services/live` on the public SDK showed five gaps; the feed had to reach into `@intent-engine/client/internal` and `@intent-engine/core/internal` and wrap its own transport. Close the gaps in the public SDK, then move the feed onto it, so a builder can write the same feed with public exports only.

## Build

1. **Events in the public core entry.** Export the event decoder and its result types from `@intent-engine/core`, plus a helper that returns every program event of a transaction, decoded from its inner instructions (the program emits events as self-calls, not as log lines), each with its instruction position.
2. **A cursor that stops.** `Transport.signaturesOf` and the RPC transport take an optional `until` signature, so a caller lists only signatures newer than the last one it stored.
3. **Timeouts and rate limits a caller controls.** `ClientOptions` gains a per-call `timeoutMs` and a `retry` setting that can turn the internal 429 retry off. When it is off, a 429 rejects with a typed SDK error that carries `retryAfterMs` from the node's `retry-after` header, so the caller decides when to read again. Defaults stay as they are today.
4. **The terms an escrow was created with.** A client read that, given a transaction and an intent address, returns the escrow's creation terms (owner, attestor, spec hash, amounts, token) from the create instruction in that transaction, or null when the transaction did not create it.
5. **Program-wide activity.** `client.activity({ until, limit })` returns the program's events newest first, each typed, with its signature, slot and block time, reading in bounded batches; it honours `retry` and `timeoutMs` and stops at `until`.
6. **Move the feed.** Change `services/live` to use only the public exports above: no import from any `/internal` entry, no hand-built transport. Its tests and behaviour stay the same, including its call budget and 429 handling.
7. **Docs and API report.** Document each addition in `docs/sdk-client.md` (and the core reference where events are described) in the repository's terse style, and update the API reports the lint checks.

## Tests

Each addition has tests against a stubbed transport: inner-instruction decoding with no log lines; the `until` cursor; `timeoutMs`; `retry: false` producing the typed error with `retryAfterMs`; creation terms found and null; `activity` ordering, batching, `until` and limits. The live feed's existing tests pass unchanged in what they assert, and a test fails if `services/live` imports an `/internal` entry.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Keep files under about 500 lines.
- Additions only: no breaking change to existing public exports or defaults.
- Read only on devnet when you try it live: no key, no signing, no sends; keep live reads few and spaced (public devnet rate-limits one IP that other services here share).

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented, documented and tested, and `services/live` free of `/internal` imports.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
