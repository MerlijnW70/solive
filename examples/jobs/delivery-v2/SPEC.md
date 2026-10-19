# Job: announcements a copier cannot reuse (T-38)

A delivery memo carries the work's sha256 and url in clear, and the judge pays the earliest announcer of the hash it accepts (`packages/core/src/memo.ts`, `packages/client/src/job-deliveries.ts`). A copier that reads a pending announcement can land the same text earlier, or in the same slot with a smaller signature, and be paid for work it did not do (threat-model row T-38).

## Build

- A v2 delivery memo, sent in the same single transaction as today: `solive-delivery2:<intent>:<c>:<blob>`.
  - `c` is the hex sha256 of a fixed tag, the intent, the announcing wallet (the transaction's fee payer) and the work's sha256, so the same `c` from any other wallet never matches.
  - `blob` seals the work url to the escrow's attestor, or to each committee member, reusing the X25519, HKDF and AES-GCM steps of `packages/core/src/sealed.ts` in a compact binary form that fits a memo.
- The judge (`judge`, `judge --watch`, the committee vote path and the release tools) opens each v2 blob with its key, fetches and hashes the work, and pays the earliest announcement whose `c`, recomputed with that announcement's own fee payer, matches the hash it accepts, together with v1 announcements of that hash.
- `solive_wallet_deliver`, `prepare_deliver` and `intent-engine deliver` send v2 by default; v1 memos are still read. `solive_wallet_check_delivery` lets a worker confirm its own `c` landed.
- After a release, anyone can recompute every `c` from the hash in the release memo and check the payee was earliest; the reputation and receipt readers use v2 announcements the same way.
- The deliver tools tell the worker to announce before making the work public.

## Rules

- No program change. Old clients' v1 memos keep working.
- A url that would not fit the transaction is refused before sending, naming the limit.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed.
- Update the T-38 row's evidence and gap in `docs/maintainers/threat-model.md`, the delivery section of `docs/judge.md` in at most four sentences, and regenerate `docs/reference`. Change only `packages/core`, `packages/client`, `packages/cli` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests show: a copier that lands the honest v2 memo text earlier, or in the same slot with a smaller signature, is not paid; the honest worker is; a v1 announcement still works; a committee member can open the blob; an outsider cannot read the url from the memo; a too-long url is refused before sending; and a third party re-derives the payee from the release memo.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
