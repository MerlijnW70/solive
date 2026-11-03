# Job: Reputation never counts what it could not read (D3)

The deep audit of the client (audit A1, findings M1, L29, L11, L3, L10) found that read errors can make a reputation look better and still complete.

## Build

1. **A failed read is not "unverifiable".** `profileKey` in `packages/client/src/refutation-standing.ts` swallows every error, including RPC failures, so a substantiated refutation becomes `unverifiable`, the refuted release is counted, and `complete` stays true. Only a profile that truly has no usable key may give `unverifiable`. A transport error must either propagate or make the record incomplete with a reason, never count the release silently.
2. **One profile-key reader.** The profile encryption key is read in five places with five error rules (`announce-keys.ts`, `refutation-standing.ts`, `first-opening.ts`, `unopened.ts`, `seal-recipients.ts`). Make one helper with one rule (missing or outdated account, invalid key, transport error each handled explicitly) and use it everywhere, keeping each caller's documented outcome.
3. **No false "no key" warning.** `keylessJudges` in `unopened.ts` turns any RPC error into "judge has no key". Only a real missing key may say that.
4. **Feedback after release only.** `feedbackOf` in `work-feedback.ts` takes the earliest owner memo at any slot, while `docs/reputation.md` says a rating counts only after a release. Ignore memos before the release.
5. **Reasons for incomplete trust.** `trust.ts` catches every error and sets `complete = false` without a reason. Catch only SDK and transport errors, record a reason, and let programming errors surface.

## Tests

Each item has a test that fails without its fix: a profile read that throws a transport error gives an incomplete record or an error, not a counted release; a profile with no key still gives `unverifiable`; an RPC error is not reported as keyless; a memo before the release is ignored; a trust read failure carries a reason.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only `packages/client` and `docs/reputation.md`. Do not touch `rpc-transport.ts`, `rpc-retry.ts`, `rpc-limits.ts`, `confirmation.ts` or `memoized-transport.ts`; another job changes them. No program change.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
