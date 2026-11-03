# Job: The monitor never loses an alert (D4)

The deep audit of the CLI (audit A2, findings C1 and O1) found two monitor faults in `packages/cli/src/monitor.ts`.

## Build

1. **No lost state alerts.** `checkOnce` builds the round's alerts from `stateAlerts`, `slotAlerts` and `fillAlerts`. `stateAlerts` records each finding's mark in `state.alerted` before `fillAlerts` runs, and `fillAlerts` can throw on a signature read. The catch then returns only an `rpc` alert, and the next round treats the state alerts as already sent, so a program-hash, upgrade-authority or config alert seen in that round is never reported. Make the round's state change only after the round succeeds, or otherwise guarantee every state alert is reported at least once even when a later read fails.
2. **A transient read does not turn the hourly run red.** `.github/workflows/monitor.yml` runs `monitor --once` on the public devnet node, and any read error becomes an `rpc` alert and a failing exit. Under `--once`, retry the round once after a short wait before alerting on a read failure. A failure that persists still alerts and fails. Real findings are never retried away.

## Tests

Each item has a test that fails without its fix: a baseline difference and a throwing signature read in the same round still report the program-hash alert, in that round or the next; one transient read failure under `--once` exits cleanly; a persistent failure under `--once` still alerts.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only `packages/cli/src/monitor.ts`, its tests and, if needed, `.github/workflows/monitor.yml`. No program change.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
