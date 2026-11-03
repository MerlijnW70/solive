# Job: Client input checks, devnet detection and read-failure classes (E5)

The deep audit of the client (A1 L7, L8, L9, L12, L21, L35) and a later review of the reputation fix found these faults in `packages/client`.

## Build

1. **Watch options are checked.** `pollMs` and `resyncSeconds` are never validated (`client.ts`); a zero poll makes back-to-back reads and a non-number disables the resync. Refuse values that are not positive finite numbers with `InvalidInput`.
2. **History cursor.** Without paged history support, `history` returns a `next` cursor its own transport then refuses (`client-reads.ts`). Return no cursor in that case.
3. **TEST on any devnet node.** `TEST` works only on the exact public devnet url string (`simple-tokens.ts`, `simple.ts`), though connect already reads the genesis hash. Decide devnet from the genesis hash.
4. **Nonce upper bound.** `checkedRef` (`intent-ref.ts`) refuses negative nonces but not ones above the u64 maximum, which fail later with a raw range error.
5. **One spec-hash parser.** Spec hashes are parsed with different rules in `announce.ts`, `simple-reads.ts`, `simple-tokens.ts` and `spec-cid.ts` (some trim and lowercase, the public CID helper does not). Use one parser.
6. **One cluster table.** `simple-tokens.ts` and `packages/cli/src/clusters.ts` keep cluster-name tables with different keys and behaviour for unknown names. Use one table with aliases.
7. **Read failures are classified fully.** `isReadFailure` (`read-failure.ts`) treats TLS and certificate errors, a non-JSON 200 reply and fetch errors outside Node as programming errors, so a reputation read throws instead of returning incomplete. Classify them as read failures, without classifying real programming errors as read failures.
8. **First rating in a slot.** Within one slot, `feedbackOf` (`work-feedback.ts`) keeps the newest rating under the newest-first order, while the rule says the first counts. Keep the first.

## Tests

Each item has a test that fails without its fix: `pollMs: 0` is refused; the fallback cursor is null; `TEST` works on a private devnet url; a nonce of 2^64 throws `InvalidInput`; an uppercase hash gives the same CID; an unknown cluster name behaves the same in client and CLI; a TLS error and a non-JSON reply make a reputation incomplete with a reason; the first of two same-slot ratings counts.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only `packages/client/src/client.ts`, `client-reads.ts`, `intent-ref.ts`, `simple-tokens.ts`, `simple.ts`, `simple-reads.ts`, `announce.ts`, `spec-cid.ts`, `read-failure.ts`, `work-feedback.ts`, `packages/cli/src/clusters.ts`, their tests, `docs/sdk-client.md` and `api-report.txt` through the repo's script. No program change.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
