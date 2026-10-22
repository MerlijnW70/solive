# Job: Differential test of the money math, TypeScript against Rust

The program runs the money math in Rust (`crates/intent-core`). The SDK runs its own copy in TypeScript (`packages/core`) to preview fees, payouts, claims and nonces before signing. Nothing checks that the two copies agree on the same inputs. Build a differential test that feeds both the same random inputs and fails on any disagreement.

## Pairs

The Rust side is the reference: it is what runs on chain.

| Rust (`crates/intent-core/src`) | TypeScript (`packages/core/src`) |
|---|---|
| `math::mul_div_floor`, `math::mul_div_ceil` | `mulDivFloor`, `mulDivCeil` |
| `fee::split_fee` | `splitFee` |
| `fee::split_fees` | `splitFees` |
| `fee::release_settles` | `releaseSettles` |
| `bounty::split_n` | `splitN` |
| `claim::Terms::new`, `claim::Terms::until` | `checkClaimTerms`, `claimUntil` |
| `claim::stake_on_release`, `stake_on_cancel`, `stake_on_settle` | `stakeReceiverOnRelease`, `stakeReceiverOnCancel`, `stakeReceiverOnSettle` |
| `mandate::lane_of`, `mandate::in_lane` | `mandateLane`, `inLane` |
| `nonce::Window::next_free` | `nextFreeNonce` |

If you find another pure money or limit function that exists on both sides, add it and list it in the report. If a row turns out to have no true counterpart, say so in the report instead of forcing it.

## What agrees means

- Same result for every input where both succeed.
- Both refuse the same inputs. A refusal on one side and a value on the other is a mismatch. Different error wording is fine; the report maps which error matches which.
- Inputs cover the edges, not only the middle: 0, 1, `u64::MAX`, values next to every bound and cap, bps at 0, the maximum and just over it, empty and full weight lists, timestamps around expiry, and nonces around window edges.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Rust test code stays out of shipped `src`.
- Do not change the Rust under `crates/intent-core/src` or `programs/`. If Rust looks wrong, stop at the report: give the input, both outputs and why you think Rust is wrong.
- When TypeScript disagrees with Rust, fix `packages/core` so it matches Rust, and add a plain unit test with that input.
- Keep public exports as they are. Keep files under about 500 lines.
- The test is seeded. By default it runs a fixed seed with at least 10,000 cases per pair, short enough to run on every CI push. `DIFF_SEED` and `DIFF_CASES` override both for longer runs. A failure prints the seed, the pair and the smallest failing input it can find.
- It runs inside `bash scripts/ci.sh` with no new tools beyond the Rust and Node already used there.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. The judge breaks one TypeScript function of each pair on purpose, for example by changing a rounding or a bound, and the differential test fails for that pair.
3. A run with `DIFF_CASES=200000` and a seed of the judge's choice passes, or every failure is in the report.
4. The report lists each pair with its case count and result, and every mismatch found with the input, both outputs and what was fixed.

## Deliver

One `git format-patch` file at a public https url, and the report. Announce the patch sha256 to the judge.
