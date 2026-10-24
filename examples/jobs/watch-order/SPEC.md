# Job: Make watch and confirmation trust only what the chain said last

A review of packages/client found that `client.watch` and transaction confirmation can report a state the chain has already moved past, and that one bad account or one throwing callback ends a watch.

1. `client.watch` keeps websocket notifications without their slot (client-watch.ts, intent-notifications.ts). A notification from slot 100 that arrives while a full read at slot 105 is running is reported after that read, so an intent that closed at slot 104 is reported alive again until the next resync.
2. After the websocket reconnects, changes missed while it was down wait for the next resync instead of being read at once.
3. An account that does not decode, or a callback that throws, rejects the whole watch. Some reads decode intents without checking the account version first (client-watch.ts, job-proofs.ts, job-pay.ts), so a future layout of the same size would be misread instead of skipped.
4. A signature notification whose shape is not `{ value: { err } }` counts as a confirmed transaction (confirmation.ts), so a transaction can be reported as landed before it executed.
5. docs/sdk-client.md says the watch rereads every `resyncSeconds`; on a transport without notifications it polls every `pollMs`. It does not say what `closed` holds.

## Required

- Every change the watch reports carries the slot it was read at. The watch never reports an account state older than one it has already reported for that address, and a notification at or below the slot of a full read that already covered the address is dropped.
- A reconnect of the notification stream triggers a full read at once.
- An account that fails its version check or does not decode is skipped and reported to `onError`, and the watch goes on. An error thrown by the callback is passed to `onError` and the watch goes on. Every intent decode in packages/client checks the version first.
- Confirmation accepts a notification only when it carries `value` with an `err` field; anything else keeps the confirmation waiting, as if no notification came.
- docs/sdk-client.md states which interval applies with and without notifications, and that `closed` holds the last state the watch saw before the account closed. Each of these sentences is pinned by a test, as the other sentences on that page are.
- Tests for each change.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Do not change the program. Keep public names and the `watch(onChange, signal, filter)` signature as they are; additions to the reported data are allowed. Keep TypeScript files under about 500 lines.
- Only these source files change: packages/client/src/client-watch.ts, intent-notifications.ts, transport.ts (only if the notification type needs the slot), confirmation.ts, job-proofs.ts, job-pay.ts, client-types.ts (only the watch types), and docs/sdk-client.md. Put new tests in a new file packages/client/test/watch-order.test.ts.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names, and the docs site still builds.
2. A test feeds a slot-100 notification during a full read at slot 105 that no longer holds the intent, and shows the intent reported closed and never reported alive afterwards.
3. A test drops and restores the notification stream and shows a change made while it was down reported without waiting for the resync interval.
4. A test shows a watch that meets an undecodable account and a throwing callback still reporting the next change, with both errors passed to `onError`.
5. A test shows a malformed signature notification does not confirm a transaction that later fails on chain.
6. A test fails when the judge removes the slot comparison from the watch.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
