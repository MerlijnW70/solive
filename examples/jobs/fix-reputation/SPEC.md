# Job: close the reputation and trust holes a review found (T-70)

An adversarial review of `packages/client/src/reputation.ts`, `trust.ts`, `funding.ts`, `transaction-keys.ts` and `delivery-openings.ts` found these, each reproducible from the code.

## Build

1. **One release counts once.** Records are keyed per announcement, so after a release a worker can post more announcements for the same intent with fresh salts, open them itself, and multiply `paid`, `earned`, `backed`, `backed_sol` and its trust edge weight. Keep exactly one record per released intent: the earliest announcement that opens to the released work, and only if it landed before the release.
2. **Unknown is not clean.** A release whose funding check is `unknown` must not count in `paid`, `backed`, `backed_sol` or trust edges; report such releases in their own count.
3. **Funding sees every way SOL arrives.** Count `CreateAccount`, `CreateAccountWithSeed`, `TransferWithSeed`, closing a token account into the wallet, and any other system or token-program lamport movement into the payer as funding; zero-lamport transfers must not let padding push the real funder out of the read window.
4. **History cannot be buried.** A reader must still find an intent's creation and release when more than the newest page of signatures references it (page until the creation or a bounded cap, and say so in `complete`).
5. **Small fixes:** `funded_by_worker` counts only funding cases, not refutations; `backed_sol` and the trust weight treat create fees the same way; trust does not renormalise shares over wallets it did not read, does not spend its wallet budget on weight-zero wallets, and limits seeds so the reader plus seeds fit the budget; failed refutation reads set `complete` false; the MCP description of rings matches what the code guarantees.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed.
- Update the T-70 row and `docs/reputation.md`, and regenerate `docs/reference`. Change only `packages` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests show: repeated self-opened announcements after a release add nothing; an announcement after the release does not count; an `unknown` funding check does not count; funding by `CreateAccount` and by a closed token account is detected; zero-lamport padding does not hide a funder; a release beyond the newest page of signatures is still read; and each small fix above.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
