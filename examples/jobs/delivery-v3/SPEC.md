# Job: salted delivery commitments with public openings (T-38)

A delivery announcement carries `c = sha256(tag ‖ intent ‖ worker ‖ h)` (`packages/core/src/sealed-delivery.ts`). When the accepted work is guessable, a copier who sees the honest `c` before it lands can test candidate hashes offline and announce first with its own commitment (threat-model row T-38). Background research: `examples/jobs/r-guessable-work` and its report. Solive has no users yet, so v2 announcements may be retired.

## Build

- Delivery v3: the worker derives a salt from its own key (the first 16 bytes of a hash of its deterministic Ed25519 signature over a fixed tag, the intent and `h`), commits `c = sha256(tag ‖ intent ‖ worker ‖ salt ‖ h)`, puts a salt check `d` (the first 16 bytes of a hash of a tag and the salt) in the memo in clear, and seals `salt ‖ url` to the judge or each committee member.
- The judge pays the earliest announcement, by slot and then signature, whose sealed salt opens its `c` to the hash of the bytes it accepted. The release memo records `h` and the payee's salt; the judge also writes one opening memo with the salts of every earlier announcement it could open, in order. Any announcer may publish an opening of its own announcement.
- Readers (receipts, reputation, trust, check-delivery, `deliveries`) mark a release valid when the payee's salt opens its commitment, and refuted when a published opening shows an earlier announcement of the same `h`.
- A worker whose signer cannot sign messages gets a clear refusal; the deliver tools can recompute their own salt and check their announcement landed.
- v2 announcements are no longer sent or read.

## Rules

- No program change.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed.
- Update the T-38 row (evidence, and a gap that names blind guessing of small answer sets and publishing before the announcement lands as not closable here), the delivery sections of `docs/judge.md` and `docs/sdk-client.md`, and regenerate `docs/reference`. Change only `packages` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests show: a copier who knows a two-value candidate set cannot match an honest commitment before it is opened; the honest earliest announcer is paid; a release whose earlier announcement has a published opening to the same hash reads as refuted; the judge's opening memo lists the earlier salts in order; and a committee member can open the sealed salt.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
