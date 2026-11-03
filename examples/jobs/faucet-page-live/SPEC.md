# Job: The faucet page and the internal status page tell the truth (D15)

The deep audit of the services (A4 F3, F16, F5 runbook part, F23 live part) found these faults.

## Build

1. **No raw token on the try page.** `services/faucet/public/try.js` prints "wait retry_after seconds" literally and adds a wait to refusals that name none, such as a funded address. Substitute a real duration as the CLI does, and add a wait only when the reason names one.
2. **The status page marks the faucet down below its floor.** `services/live` marks the faucet "up" from one drip's worth of SOL, while the faucet refuses every drip below its balance floor. Use the faucet's floor, from one shared constant or a test that ties them.
3. **Instant faucet runbook.** `services/faucet/README.md` has no deploy and funding section, and the top-up script defaults to the issue faucet's wallet. Add deploy and funding steps for the instant faucet, name the wallet each script refills, and correct the monitor floor so a day at the daily cap is covered, with the test reading the cap from the faucet's limits instead of a copied number.
4. **No test-only state in shipped src.** `services/live/src/store.ts` keeps a `writes` counter only a test reads. Observe through the test's own stub instead.

## Tests

Each item has a test that fails without its fix: the page shows a duration, never "retry_after seconds", and no wait for a funded address; one SOL reads down on the status page; the monitor floor test follows the faucet's daily cap; the live store has no test-only member.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only `services/faucet/public`, `services/faucet/README.md`, `services/live`, `scripts/faucet-topup.sh`, `docs/maintainers/operations.md`, `.github/workflows/monitor.yml` (floor value only), `packages/cli/test/faucet-site.test.ts`, `monitor-instant-faucet.test.ts`, `monitor-workflow.test.ts`. Do not touch `services/faucet/src`. Do not deploy anything. `services/live` stays internal: do not link or promote it.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
