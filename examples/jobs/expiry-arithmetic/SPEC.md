# Job: Every computation on an escrow's expiry holds for every expiry the program admits

Round H16 found an escrow that can never be closed. `close_intent` computes `expires_at.checked_add(HELD_CLAIM_SECS)` for every intent, before it looks at whether anything is held. Admission accepts any `expires_at` above now, and the tests themselves create one at `i64::MAX`. So an intent whose expiry lies within `HELD_CLAIM_SECS` of `i64::MAX` fails `close_intent` with `Overflow` for ever.

When such an escrow was filled with a withheld fee (a fee account that requires memos, for example), or was cancelled, its withheld tokens, vault and account rent, and crank bounty stay locked. `examples/jobs/expiry-arithmetic/case.patch` adds the test that shows this. It fails on `main` today.

## Required

1. Find every computation in `programs/` and `crates/intent-core` that adds to, subtracts from or compares with an expiry or a time derived from one. Include at least:
   - `close_intent`'s held window;
   - claim terms (`Terms::until`);
   - stand-by service times;
   - mandate lifetimes;
   - auction decay;
   - expire and cancel windows;
   - announcement and refutation windows;
   - mint-cap bookkeeping.
   Each one must give the right answer, or a refusal the program documents, for every expiry admission accepts, up to `i64::MAX`, and for every clock value.
2. Fix each at its cause. A guard that only matters when something is held is evaluated only then. A deadline compares without overflowing, for example `now - window >= expires_at` with the subtraction checked on the side that cannot overflow, or a saturating sum whose meaning is right at the bound. Do not cap `expires_at` at admission unless every computation still needs it after the fix; if you add a cap, document why it is the better fix.
3. The case passes after the fix. Turn it into a regular test asserting that the escrow closes and refunds every base unit to the owner, and add tests at `i64::MAX` and at `i64::MAX - HELD_CLAIM_SECS ± 1` for:
   - close with and without held shares;
   - cancel then close;
   - a claim's term on a far-expiry escrow;
   - a stand-by service time;
   - expiry handling.
4. Update docs/maintainers/catalog-classes.md (row C-419 says expiries are bounded; make it true or correct it) and docs/maintainers/threat-model.md. Regenerate the IDL, the generated client and the references if the interface changes.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Program and `intent-core` changes are allowed for this job.
- Keep TypeScript files under about 500 lines.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names, these pass:
   - `cargo test --workspace`;
   - `bash scripts/ts-test.sh`;
   - `bash scripts/lint.sh`;
   - `bash scripts/pack-test.sh`.
2. The tests in Required 3 pass, and the case's escrow closes and refunds.
3. A test fails when the judge restores the unconditional `checked_add` in `close_intent`.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
