# Job: a filler that spends a capped float, not its whole inventory (T-62)

The solver signs fills with the key that owns its whole inventory, so stealing that key steals everything (threat-model row T-62). `fill_intent` only needs the solver to be the transfer authority of its output account (`programs/intent_engine/src/instructions/fill_intent.rs`), and an SPL token delegate is a transfer authority up to its approved amount.

## Build

- The solver takes an inventory owner (`--inventory-owner <address>`, and in its config) distinct from its signing key. It fills from and is paid into the inventory owner's token accounts, acting as their delegate, and never holds inventory itself.
- `intent-engine solver float --keypair <owner key or Ledger path> --delegate <solver key address> --mint <mint> --amount <amount> [--yes]` approves the delegate for that amount on the owner's account, and `solver float show` prints each mint's remaining allowance.
- The solver treats the remaining allowance as its stock: it skips fills the allowance cannot cover, with a reason in its report, and says when an allowance runs low.
- Without `--inventory-owner`, the solver behaves exactly as today.

## Rules

- Reuse the solver's inventory and holds logic for the allowance; do not keep a second stock count.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed.
- Update `docs/solver.md` in at most five sentences, the T-62 row in `docs/maintainers/threat-model.md`, and regenerate `docs/reference`. Change only `packages` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. LiteSVM tests show: a delegate fill moves the owner's tokens and pays the owner's account; a fill above the remaining allowance is skipped without sending; the delegate key alone can move at most the allowance; `solver float` approves and `float show` reads the allowance; and without an inventory owner the solver is unchanged.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
