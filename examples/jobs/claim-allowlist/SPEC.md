# Job: Let an escrow's owner name who may claim it

A review of invite-only jobs found that any wallet can take or queue a claim on a proof escrow that takes claims. The wallet tools now refuse an uninvited wallet, but a wallet that sends its own transaction can still hold the claim, and while it holds, the invited worker cannot be paid: `wallet_attest` is refused with `ClaimHeld` until the claim lapses. Only the program can close this.

## Required

- The owner of a proof escrow can name the wallets that may claim it: up to 32 workers, set when claims are opened or by a separate owner instruction while no claim is held and nobody is in the stand-by line. Once set, the list cannot change.
- `claim_job` and `stand_by` refuse a worker that is not on the list, whatever accounts the transaction passes; an escrow with no list behaves exactly as before. A claim board records whether a list applies, so leaving the list account out of a transaction cannot skip the check.
- The rent of any account that holds the list returns to the owner when the claims board is settled or closed, as the board's rent does.
- Existing claims boards and escrows keep working; account versions change only where needed, following how the program already versions accounts.
- The client builds the new instructions; `intent-engine claims open` takes the list; `wallet_escrow` and `wallet_escrow_plan` set the list automatically to the workers a sealed spec at `spec_url` is sealed to, leaving out the owner and the attestor, and say so in the preview; `solive_get_claims` and `intent-engine claims show` show the list.
- The IDL, generated client and generated references are regenerated, and the proofs and checks the repository runs for program changes pass.
- Tests for each change.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. This job may change the program. Keep public instruction names and existing arguments as they are; add new ones. Keep TypeScript files under about 500 lines.
- Do not deploy anything; the judge deploys after acceptance.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names, including the Rust tests and the proofs it runs, and the docs site still builds.
2. A LiteSVM test opens claims with a list, has an unlisted wallet send its own `claim_job` and `stand_by` transactions, with and without the list account, and shows both refused on chain, while a listed worker claims and is paid with `wallet_attest`.
3. A LiteSVM test shows an escrow without a list behaving as before, and the list's rent returning to the owner when the board is settled.
4. A test fails when the judge removes the list check from `claim_job`.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
