# Job: Kani proofs for the new money paths

`tests/proofs` proves lifecycle, lanes, windows and fee splits with Kani. The money logic added since then has no proof: the settle check, the three stake decisions, mint cap accounting, the migrate top-up and the stand-by line. Prove it.

## Build

1. **Pure functions.** Move any arithmetic or decision logic below that lives in the program crate into `crates/intent-core`, as pure functions without Anchor types. The program calls them, and its behaviour stays exactly the same. This applies to the cap charge, `give_back` and refund arithmetic in `caps.rs`, `top_up_for` in `migrate.rs`, and the stand-by line's join and advance.
2. **Proofs in `tests/proofs`**, one file per area, for all inputs within the types:
   - **Settle check:** `release_settles` holds exactly when `split_fees` on `amount − judge_fee` succeeds, and a release under it never pays out more than `amount`.
   - **Stakes:** `stake_on_release`, `stake_on_cancel` and `stake_on_settle` never pay a stake to more than one party, and agree with each other: a lapsed claim always goes to the owner, and a held claim never goes to the owner.
   - **Mint caps:** over a bounded sequence of charges, give-backs and refunds, the outstanding total equals the sum of the live intents' capped amounts and never exceeds `total_limit` after a charge. A refund never makes a later charge pass that should fail. The created_at rule (decrement only when `cap.created_at <= intent.created_at`) never lowers a recreated cap below its own charges.
   - **Migrate top-up:** the result never lowers lamports, and afterwards the account holds at least the new size's rent plus any held stake.
   - **Stand-by line:** join and advance keep `head <= tail`, never skip or repeat a position, and `waiting()` equals the number of entries joined and not yet served.
3. **CI.** `scripts/kani.sh` runs the new proofs, and the GitHub `kani` job runs them as it runs the existing ones.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Rust tests live outside `src`.
- Bound loops and sequences so every proof finishes on a normal machine, as the existing proofs do. Record the bounds in `docs/maintainers`.
- Change only `crates`, `programs`, `tests` and `docs`. The IDL and the account layouts must not change.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. `bash scripts/kani.sh` verifies every proof: the existing ones and the new ones.
3. Each new proof fails when the property it states is broken. Show this in the report with one deliberate mutation per proof, which the patch does not include.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
