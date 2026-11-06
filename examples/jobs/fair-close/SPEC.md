# Job: Fair closing for proof escrows, on-chain (fair-close)

Implement design D3 from `F:\solive-kit\outside-jobs\fair-close-design\out\design.md`. The design's sha256 is `98c0d155f8982409a75da60f4b67a41089367a88dde21f1d113faf42cb72ae67`; check that the file you read has it. Use its sections 2, 5 and 6.1 to 6.3 as the bar, with the decisions below. Path prefixes in the design: `P/` is `programs/intent_engine/src/`, `I/` is `programs/intent_engine/src/instructions/`, `C/` is `crates/intent-core/src/`, `T/` is `tests/svm/tests/`.

**Rules:** every invariant in design section 2 holds on-chain for every instruction, not only the instructions the design names. That covers W1 to W5, H1 to H6, J1 to J3 and L1 to L4. Find every instruction that moves the vault, a claim stake or board lamports, or that changes a slot, an announcement or the delivery book. Show that each one keeps every invariant.

## Decisions (approved by the owner)

| # | Decision |
|---|---|
| 1 | `CANCEL_NOTICE_SECS = 86_400`, fixed in the program. |
| 2 | `review_secs` is 0 (off) or from `3_600` to `604_800`. |
| 3 | `kill_fee` is 0 or from the rent minimum to 100 SOL, and needs a stake above 0. |
| 4 | `kill_fee` is paid in lamports from the claim board, not in the escrow's token. |
| 5 | A reject returns the holder's stake to the holder. |
| 6 | The escrow stays open after a lapse is paid. |
| 7 | Protection is opt-in per escrow, through claims with `review_secs > 0`. |
| 8 | A lapse during `PAUSE_FILL` still pays `held + kill_fee`. |
| 9 | A release after a paid lapse is allowed. |
| 10 | Cancel while a claim is held and nothing has been announced keeps today's rules. |

The CLI defaults from design 5.7 (the review window and a kill fee equal to the stake) belong to the follow-up CLI job, not to this one.

## Build

1. **Program.** Make the account changes from design 5.1, with their version bumps and the stated read and write rules for older accounts. Add the instructions and checks of 5.2, in the stated order. Add the errors of 5.3, the bounds of 5.4 and the events of 5.5. `reject_delivery` signs the digest J2 describes, covering both a key judge and a committee threshold. Reuse the existing signature and cosign checks; do not write a second verifier.
2. **intent-core.** Put the pure logic in `crates/intent-core`, beside the existing claim and delivery logic, with no std and no anchor: review arming, the held-while-in-review slot rule (design 5.1), lapse payout, cancel notice and bounds. The program calls it. Every core function that moves or assigns lamports has a Kani harness, following the existing pattern under `scripts/kani.sh`.
3. **IDL and TS core.** Regenerate the IDL (`scripts/idl.sh`) and `packages/core/generated`. Add builders for `request_cancel`, `reject_delivery`, and `review_secs`/`kill_fee` on `open_claims`, in `packages/core`. Update the builder fixtures. Make no changes in `packages/cli` or `packages/client`; the follow-up job does those.
4. **The invariant map.** In the report, list every instruction in the program, and per instruction the invariants it can affect and the test that pins each one.

## Tests

- Every LiteSVM test in design 6.1, one per invariant and one per attack. Where the design names a test, use that name or a clearer one, and map each one in the report.
- The intent-core unit and property tests in 6.2, and the model and fuzz actions and properties in 6.3, including lamport conservation and vault conservation.
- Kani harnesses from item 2 pass.
- The existing svm, core, model, fuzz and TS suites pass. Do not weaken any assertion. Existing tests that encode cancel-after-announcement (`T/announcement_close.rs`) change only as far as the new notice rule requires; list each change with its reason.

## Self-check before delivering

A reviewer will attack your patch in these ways. Check each one yourself and report what you found:
- Every attack in design 5.6, replayed as a test against your code, not against the design.
- Find another route to the same hole. Can any instruction move the vault, a stake or board lamports, or change a slot, while a review is armed or a cancel notice runs? Try `advance`, `claim_job` on a lapsed slot, `drop_claim`, `extend_claimants`, `list_claimants`, `stand_by`, `leave`, `close_intent`, `close_announcement`, splits, committee releases and `refute_release`.
- Boundary values: `review_until == expires_at`, a clock exactly at `review_until`, at `cancel_at` and at `expires_at`, `kill_fee` exactly at the rent minimum, `review_secs` at both bounds, and a board with the maximum number of claimants.
- Can a kill fee be paid twice, to a non-holder, or after a reject or a release before `review_until`?
- Can old-version accounts bypass a new check?

## Rules

- Follow `CONTRIBUTING.md`: no code comments except the kept markers, nothing bypassed, no test code in shipped `src`.
- This is a program change. Do not deploy anything, do not touch devnet, keys, wallets or the multisig, and do not change `declare_id`.
- Rebase onto the latest local `main` of `F:\solive` right before delivering, rerun the tests, and name the base commit in the report.
- Never write to the shared git config.
- Run the full Rust tests (`scripts/test.sh`), Kani for the new harnesses, the full `packages/core` suite, typecheck, lint and the docs checks. The judge runs the full CI.

## Report

- The invariant map from item 4.
- The test map for 6.1 to 6.3.
- Each changed existing assertion and why.
- The self-check findings.
- The compute units of each new or changed instruction, against today's.
- **Same defect elsewhere:** `path:line — why`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. An adversarial review confirms every invariant holds on every instruction, and that the self-check attacks fail.

## Deliver

One `git format-patch` file plus the report. Announce its sha256 to the judge.
