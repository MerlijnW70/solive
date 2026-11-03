# Job: Send and confirmation errors tell the truth (D2)

The deep audit of the client (audit A1, findings M2, L1, L14, L19) found that the client reports some sends wrongly and ignores a caller's retry choice in places.

## Build

1. **Unsent is not "maybe sent".** In `packages/client/src/rpc-transport.ts`, `sent()` wraps every `SdkError` in `MaybeSent`, because `refusedUnsent` in `rpc-retry.ts` returns false for all of them. A `Cancelled` raised by `limitedTransport` before the request was issued, and a `RateLimited` under `retry: false`, never reached the node. Reject them unchanged, as `docs/sdk-client.md` already promises. Do not weaken `MaybeSent` for anything that may have reached the node.
2. **`retry: false` holds everywhere.** Confirmation and signature-status reads (`confirmation.ts`, and the calls in `rpc-transport.ts` that pass no retry flag) still retry rate limits under `retry: false`. Pass the caller's choice through.
3. **Short replies are errors.** A node that answers `getMultipleAccounts` or `getSignatureStatuses` with fewer entries than asked makes accounts read as missing and signatures as not landed (`rpc-transport.ts`, `memoized-transport.ts`). Treat a reply of the wrong length as a transport error.
4. **Bounded reply size.** `limitedTransport` bounds time only. Add an optional cap on the bytes of an RPC reply, off by default, documented in `docs/sdk-client.md`, and refuse a larger reply with a clear `SdkError`.

## Tests

Each item has a test that fails without its fix: a send on an already aborted signal rejects `Cancelled`; a send 429 under `retry: false` rejects `RateLimited`; a confirmation 429 under `retry: false` rejects at once; a short reply throws; a reply over the cap is refused.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only `packages/client` and `docs/sdk-client.md`. Additions to public exports only; update `api-report.txt` through the repo's script. No program change.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
