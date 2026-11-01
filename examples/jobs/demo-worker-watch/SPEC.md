# Job: Keep the demo worker delivering when its subscription closes

The devnet demo worker (`scripts/demo-worker.mts`, run by `scripts/demo-worker.sh` as a service) logs `{"round":"failed","path":"watch","detail":"the subscription closed"}` about once a minute, for hours, including right after a restart. A new user's demo job depends on it. Find out why the subscription closes and make the worker keep finding and delivering demo jobs anyway.

## Build

1. **Cause.** Find why the watch subscription closes (node side closing idle websockets, a missing keep-alive, a reconnect bug, or the client), with evidence: a reproduction, logs, or the code path. Say it in the report.
2. **Keep delivering.** When the subscription closes, reconnect with backoff, and between reconnects fall back to polling the program's recent demo escrows at a bounded rate, so a new demo escrow is still claimed and delivered within the time the docs promise. Never deliver twice or claim a job it cannot finish.
3. **Quiet, honest logs.** A closed subscription that is handled logs once per state change, not every minute; a round that really fails still logs as failed.

## Tests

Each fails if its behaviour breaks: a subscription that closes is reopened with backoff; while it is closed, a new demo escrow is found by polling and delivered once; repeated closes do not flood the log; the existing demo worker tests pass unchanged in what they assert.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- No program change. Read-only devnet calls only while investigating, few and spaced; the demo worker's own key is not yours to use.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. The report names the cause with evidence.
3. After the judge restarts the service on the patch, a new demo escrow is delivered and the log no longer shows a failed round every minute.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
