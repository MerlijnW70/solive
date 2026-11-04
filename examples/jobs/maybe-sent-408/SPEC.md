# Job: A send the node may have processed is never reported as unsent (H1)

**Rule:** a send that may have reached the cluster is never reported as unsent. Freeing a spending allowance, and saying "nothing was sent", both require proof that the request was refused before processing.

The review of F2 found two places that break this rule. Both count any HTTP 4xx from an RPC node as refused before sending, including 408 and 425:

- `rpcRefused` in `packages/cli/src/agent/wallet/guard.ts`
- `refusedUnsent` in `packages/client/src/rpc-retry.ts`

A gateway that has already forwarded `sendTransaction` and then times out can answer 408. The tool then reports "not sent" and frees the reserved allowance. An agent that signs again with a fresh blockhash pays twice, and the daily cap undercounts.

## Build

1. **Find every caller.** Search the whole repo for every place that decides "unsent" or "refused before sending" from an HTTP status, an RPC error or a transport error. List each place in the report.
2. **Classify the statuses.** Treat 408 and 425 as maybe-sent in both places. Keep a status as unsent only where it proves the request was refused before processing, and show the reason for each status you keep.
3. **Keep callers consistent.** Callers that free allowances or word a partial send must follow the new classification:
   - `worker.ts`
   - `offer.ts`
   - `work-claims.ts`
   - `escrow.ts`
   - `trade.ts`
   - any others found in step 1

## Tests

- A send answered with 408 is reported as maybe-sent, keeps its allowance reserved, and is not re-signed.
- This holds for the MCP wallet tools and for the client transport.
- A 400 that proves refusal stays unsent.
- Each new test fails without its fix.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Files: those named here and those found in step 1, with their tests and generated references. No program change.
- Run only the touched tests plus typecheck, lint and the docs checks. The judge runs the full CI.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test. It also finds no other route that reports a possibly processed send as unsent.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
