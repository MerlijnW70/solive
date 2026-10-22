# Job: Prove committee signer selection with Kani

`crates/intent-core/src/committee.rs` decides which committee members must have signed before an escrow is released: `Committee::new`, `Committee::from_stored` and `Committee::signers(mask)`. It is only covered by a proptest (`crates/intent-core/tests/committee.rs`). Every other money path in `intent-core` has Kani proofs in `tests/proofs`.

## Required

Kani proofs in `tests/proofs/src`, run by `bash scripts/kani.sh`, over every member count up to the maximum, any threshold and any `u8` mask, that show:

- `signers(mask)` succeeds only when the mask names no position beyond the members and names at least `threshold` of them.
- On success, `keys()` returns exactly the members named by the mask, in member order, with no duplicates.
- `new` refuses an empty member list, a threshold of 0 or above the member count, and duplicate members; `from_stored` accepts exactly what `new` accepts, and both give the same `preimage()` for the same input.

If a property does not hold, stop and report the counterexample instead of changing `committee.rs`.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Only `tests/proofs`. No change under `crates/intent-core/src` or `programs/`.
- Keep the proofs fast enough for the existing CI kani job; use bounds and stubs as the other proofs in `tests/proofs` do.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. `bash scripts/kani.sh` passes every proof, old and new.
3. The judge breaks `signers` on purpose (for example `<` for `<=` in the threshold check, or dropping the bound check on the mask) and a new proof fails each time.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
