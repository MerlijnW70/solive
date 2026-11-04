# Job: Find why a signer without authority gains lamports in the adversary test (G1)

The proptest `a_signer_without_authority_cannot_break_any_invariant` in `tests/svm/tests/adversary.rs` fails, and replays deterministically on main, with this minimal input:

```
token_2022 = false, steps = [
    Attack { base: 30, mutations: [] },
    Attack { base: 30, mutations: [] },
    Attack { base: 35, mutations: [Account { slot: 19, pick: 0 }] },
]
```

The message reads `step 2 ...: attacker gained 6204600 lamports but only 50000 in bounties and 0 in forfeited rent were released`. The proptest seed is `cc ca07131025b0d6f16471d4fb8be5c7eb4c54647f752329c0e31462e34800e12c`.

## Build

1. **Root cause.** Name the exact instruction and accounts behind attack bases 30 and 35 and mutation slot 19 (`tests/svm/tests/hostile/`). Trace every lamport the attacker gained, by account and transfer. Decide, with evidence, which case this is:
   - **(a) Program defect.** The attacker takes lamports it never paid in.
   - **(b) Test model defect.** For example, the attacker gets back rent it paid itself in earlier steps, and the invariant counts that as a gain.
2. **If (a):** add a focused LiteSVM test that fails on the current program and states the hole. Write the fix in the program, and show that the test passes with it. The program fix ships in the next devnet redeploy through the multisig. Search every other instruction with the same pattern and list each.
3. **If (b):** correct the invariant so it counts only lamports the attacker did not pay in itself. Do not weaken it. Prove the corrected invariant still catches a real theft with a planted defect. Keep the seed in `adversary.proptest-regressions`.
4. **Same defect elsewhere.** Check every other invariant in `tests/svm/tests/hostile/` for the same accounting gap, and every other instruction for the same kind of hole.

## Tests

- The seed replays green after the fix.
- A planted theft makes the invariant fail.
- If (a), the focused test fails on the old program.
- Run `ADVERSARY_CASES=2000` once and report the result.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- Only `tests/svm/`, plus `programs/intent_engine/src/` if (a) holds, with their tests.
- No devnet sends.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review confirms the root cause from the trace, and confirms that no invariant was weakened.

## Deliver

One `git format-patch` file and a written trace. Announce the patch's sha256 to the judge.
