# Job: Test agent mandates and their nonce lanes at every limit

A mandate (`create_mandate`, `revoke_mandate`) lets an agent open intents for an owner through `create_intent_by_agent`, within the mandate's limits (`Limits::admit` in crates/intent-core/src/mandate.rs). Each mandate gets a serial from the owner's `UserState.grants`, and its intents must use nonces in that serial's lane (`lane_of`, `in_lane`). Advancing the owner's epoch (`advance_epoch`) and revoking stop a mandate. `tests/svm/tests/mandate.rs` and `r2_delegation.rs` cover only a few of these cases.

## Required

1. Tests in `tests/svm` for each limit, at the limit itself and at the smallest step past it:
   - `per_intent` including the agent fee;
   - `total` over several intents;
   - `max_intents`;
   - `max_ttl`;
   - `valid_until`;
   - every kind bit;
   - the price floor (`floor_out` and `floor_in`, including the largest values the types allow);
   - the fixed partner and partner bps;
   - the input account, the output account and both mints.
2. Tests for the lanes:
   - a nonce just outside the mandate's lane, on both sides, is refused;
   - two mandates of the same owner never accept the same nonce;
   - a nonce the owner uses directly never collides with a lane;
   - the serial limit `MAX_LANE_SERIAL` is refused cleanly;
   - a mandate created again with the same id after a revoke gets a new lane.
3. Tests for stopping a mandate:
   - after `revoke_mandate` and after `advance_epoch`, the agent can open no intent;
   - intents opened before the stop can still be filled, cancelled by the owner and expired, with every balance correct to the base unit;
   - the agent fee of each intent goes where the program sends it in each of these paths;
   - the mandate's `spent` and `intents` counters change exactly as the program defines when an intent it opened is cancelled or expires, and the test names that behaviour.
4. The CLI and MCP mandate tools (packages/cli/src/agent/mandate-*.ts) agree with the program for every limit in Required 1:
   - a request the program would refuse is refused before signing, with the same reason;
   - a request the program accepts is not refused.
   Test this with the test world.
5. Add a short table to docs/maintainers/catalog-classes.md, in a new section, listing each limit and stop with its test name and the behaviour found.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- Change only `tests/svm`, the CLI mandate tools and their tests, and the docs table. Make no change under `programs/` or `crates/`. Keep TypeScript files under about 500 lines.
- Some cases may break the limits: an agent spending past them, an intent the owner cannot cancel or get refunded, a lane collision, or a stopped mandate still opening an intent. Do not change the program for such a case. Instead:
  - write it as a separate test file outside the patch;
  - describe it in the report with the amounts at stake;
  - keep the patch's own tests passing by asserting only what holds.
- A CLI or MCP tool that disagrees with the program is fixed in the patch at its cause.

## Acceptance

1. `cargo test --workspace`, `bash scripts/ts-test.sh` and `bash scripts/lint.sh` pass with the patch applied to `main` at the commit the delivery names.
2. Every limit, lane case and stop in Required 1 to 3 has a test, listed in the docs table and in the report.
3. A test fails when the judge changes one expected amount or one expected error in a new test.
4. A test fails when the judge removes the CLI or MCP check that refuses, before signing, an intent that would stay open past the mandate's `max_ttl` (the check the patch keeps or adds; the report names its file and line).

## Deliver

One `git format-patch` file, plus any separate case files from the rules. Announce the patch's sha256 to the judge.
