# Job: Test the claim board, stakes and the stand-by line against every escrow event

An escrow that takes claims has a claim board (`claim_job`, `drop_claim`, `settle_claims`), an optional claim list (`open_claims_listed`, `list_claimants`, `extend_claimants`), and a stand-by line of entries (`stand_by`, `leave`, `advance`). Each holds lamports: the claim stake on the board, and rent plus stake on every stand-by entry. `tests/svm/tests/claims.rs`, `standby.rs` and `claim_list.rs` test these paths one at a time. Nobody has checked every board state against every event that can end, release or close the escrow, with the lamports counted.

## Required

1. Tests in `tests/svm` that cross each board state with each escrow event:
   - **Board states:**
     - free;
     - held by a worker within its time;
     - lapsed;
     - held, with stand-by lines of one and of several entries;
     - dropped while a line waits;
     - each of these on an open board and on a listed board.
   - **Escrow events:**
     - a new claim;
     - `stand_by`, `leave` and `advance`;
     - `drop_claim`;
     - an attested release that pays the holder;
     - an attested release that pays someone else;
     - a split release that names the holder, and one that does not;
     - a committee release;
     - cancel;
     - expire;
     - `settle_claims` before and after the escrow ends;
     - `close_intent`.
2. Each test counts lamports. Every lamport paid into the board or into a stand-by entry ends exactly where the program's rules send it: the worker, the owner, or the next worker in the line. The board and every entry are closed, or can still be closed by someone, once the escrow is closed. The test asserts each balance to the lamport.
3. Each test also checks who can claim next. A worker the line serves gets the claim with the stake and time its entry recorded. A barred worker is refused with the named error. Nobody can take or keep the claim against the rules the error names.
4. Add a short table to docs/maintainers/catalog-classes.md, in a new section beside the claim rows. It lists each state and event with its test name and the behaviour found.
5. Reuse the existing claim and line helpers in `tests/svm`. Add helpers rather than copying them.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- Change only `tests/svm` and the docs table. Make no change under `programs/` or `crates/`.
- Some cases may break the rules above: lamports that stay locked for good, a stake paid to the wrong party, a line that can no longer be served or closed, or a claim taken against the rules. Do not change the program for such a case. Instead:
  - write it as a separate test file outside the patch;
  - describe it in the report with the lamports at stake;
  - keep the patch's own tests passing by asserting only what holds.

## Acceptance

1. `cargo test --workspace` and `bash scripts/ts-test.sh` pass with the patch applied to `main` at the commit the delivery names.
2. Every state and event pair in Required 1 has a test, listed in the docs table and in the report. If a pair cannot occur, the table says why, and a test shows the refusal.
3. A test fails when the judge changes one expected lamport amount or one expected error in a new test.

## Deliver

One `git format-patch` file, plus any separate case files from the last rule. Announce the patch's sha256 to the judge.
