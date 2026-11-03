# Job: Make the instant faucet's limits hold against outside traffic (D1)

The deep audit of the services (audit A4, findings F1, F2, F4, F13, F14) found that the instant faucet's limits in `services/faucet` can be used against it. Fix them at the root.

## Build

1. **Daily cap counts only real drips.** `dailyCount` in `services/faucet/src/chain.ts` counts every successful transaction that names the faucet, so anyone can fill the day's cap with tiny transfers to the faucet address, and failed transactions fill the `seen` budget and turn into `busy`. Count only transactions the faucet itself paid for, as `earlierDrip` checks with `accountKeys[0]`. Foreign and failed entries must not use up the cap or the read budget in a way an outsider can steer. Keep the number of reads per request bounded. Check the window before the budget, as `earlierDrip` does.
2. **Refusals are not free reads.** `drip.ts` releases the caller's reservation whenever nothing was sent, so a caller can make the faucet read the node without limit by asking for refused drips. Give work that reached the node a bounded cost per caller, separate from the drip quota, so honest users are not refused for an earlier refusal. Avoid repeating the same recipient history read within a short time.
3. **Per-instance limits are said plainly.** The per-network limit and the in-flight hold live in one function instance's memory. Either make the per-address rule hold across instances, or say "per instance" wherever the page, README and refusal texts promise the limit. Choose the root fix if it fits the service without new infrastructure; otherwise state the limit truthfully.
4. **A timed-out send is not "no SOL arrived".** When `sendTransaction` errors after the transaction may have been accepted, check the signature once before telling the caller nothing arrived, and say so truthfully when it cannot be known.

## Tests

Each item has a test that fails without its fix: an incoming tiny transfer does not count toward the cap; many foreign or failed entries do not give `busy`; an in-window run with one old entry is open; repeated refused requests from one caller stop reaching the node after its budget; a send error after acceptance does not claim no SOL arrived. Update `services/faucet/test/daily.test.ts` where it locked in the old count, and say why in the delivery report.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only `services/faucet` and its README, plus `packages/cli/test/faucet-site.test.ts` if a text changes. No program change. Do not deploy, do not call the live faucet.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
