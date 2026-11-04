# Job: Every reader of fills shows every payout, and every pre-check follows the program (H3)

**Rules:**
1. Every place that shows money moved by a fill shows every payout the program emits for it.
2. Every client pre-check refuses what the program refuses, before anything is sent.

The reviews of F5 found the gaps below.

These readers drop `AgentPaid` and `RelayerPaid`:
- `packages/cli/src/agent/wallet/fills.ts`
- `packages/cli/src/agent/wallet/history.ts`
- `packages/cli/src/monitor-fills.ts`
- `services/live/src/activity.ts`

Fill receipts do not show an agent fee that was withheld (`FeeWithheld`, role agent). A null `relayerPaid` beyond the page cap looks the same as "no relayer".

`client.fill` (`packages/client/src/client-intents.ts`) does not check whether the mandate is live. It builds fills that the program refuses with MandateRevoked.

`closeLegacy` (`packages/cli/src/legacy-commands.ts`) does not mirror the program's `DeliveryRecordKept` refusal.

## Build

1. **Find every payout reader.** Search the whole repo for every reader of fill or release events. List each one, and show `AgentPaid`, `RelayerPaid` and withheld fees in each, using the core event names.
2. **Mark incomplete reads.** Give fill receipts a completeness flag when the scan stops at its page cap.
3. **Find every client pre-check.** Search for every client or CLI pre-check that mirrors a program refusal and list each one. Add the mandate-liveness check to `client.fill`, reusing the solver's `deadMandate`. Add the delivery-record refusal to `closeLegacy`.

## Tests

- Each named reader shows the agent and relayer payouts of a real agent-created fill and of a real relayed fill.
- A withheld agent fee is shown.
- A receipt cut off by the page cap says so.
- `client.fill` refuses an intent whose mandate was revoked, and sends nothing.
- `closeLegacy` refuses a delivery record before sending.
- Each new test fails without its fix.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only the files named here and the ones step 1 or 3 finds, with their tests and the generated references. No program change.
- Run only the touched tests plus typecheck, lint and the docs checks. The judge runs the full CI.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
