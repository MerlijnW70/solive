# Job: The spec mirror cannot be filled for good by one party (D16)

The deep audit of the services (A4 F9, F15, F23 specs part) found that the spec mirror in `services/specs` can be filled permanently: an upload needs only an open proof escrow with that hash, with no minimum pay or age, bytes are kept forever, and once the store cap is reached every new spec gets 507.

## Build

1. **Per-owner quota.** Limit the stored bytes per escrow owner (the owner is in the escrow account the service already reads), so one owner cannot fill the store while others can still upload. Choose and document a sensible limit.
2. **A cost to upload.** Require something an attacker cannot get back cheaply before storing, such as a minimum escrowed amount or a minimum escrow age, and document it. Keep honest uploads at escrow time working.
3. **Space comes back.** Specs of escrows that are long closed and whose bytes no open escrow needs can be removed after a stated time, so the cap is not permanent. Keep the guarantee that a stored spec's bytes never change.
4. **One caller rule.** `callerOf` and the forwarded-for rule are written in both `services/faucet/src/request.ts` and `services/specs/src/http.ts`; share one, or tie both with one test over the same header table.
5. **No test-only state in src.** `BodyBuffer.held` in `services/specs/src/http.ts` is read only by a test; observe through the test instead.

## Tests

Each item has a test that fails without its fix: one owner cannot exceed its quota while another still stores; an upload below the cost is refused; an expired spec of a closed escrow is removed and a needed one is kept; both services parse the same forwarded-for table the same way.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only `services/specs`, `services/faucet/src/request.ts` (caller rule only) and their tests and READMEs. Do not deploy anything and do not upload to the live mirror.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
