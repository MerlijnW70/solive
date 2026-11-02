# Job: Stop the instant faucet draining in hours, and show who asks (F1)

The instant faucet in `services/faucet` sent 18 drips of 0.5 SOL in one evening, most to new wallets that never spent them. `CALLER_DRIPS` counts per network and per function instance, so it does not bound the faucet as a whole. Its logs hold only the status and the signature, so nobody can tell whether one source asks.

## Build

1. **A cap for the whole faucet.** Add `DAILY_DRIPS` to `services/faucet/src/limits.ts`, set to 20. Before sending, `services/faucet/src/drip.ts` counts the faucet's own transactions in the last `DRIP_WINDOW_SECS` from its signature history on the node, so the count holds across instances and needs no storage. At or over the cap the answer is 429 with `retry-after` set to when the oldest counted transaction leaves the window, and a new reason in `REASONS` that says the faucet has reached its daily limit and names another way to get devnet SOL. A count that cannot finish within the existing page limits refuses the same way. A node failure keeps today's 503. Check the cap after the recipient checks, so a refused recipient costs no extra read.
2. **A caller mark in the log.** Each log line also holds `caller`, the first 16 hex characters of a sha256 over the faucet secret, the current UTC day, and the caller from `callerOf`, plus `agent`, the first 80 characters of the request's user-agent with control characters removed. The raw address is never logged. With no secret set, `caller` is left out.
3. **Docs.** Update `services/faucet/README.md` with the cap and what the log holds. If any text on the faucet site in `services/faucet/public` makes a statement about logging or privacy that this makes false, correct it.

## Tests

Each fails if its behaviour breaks: with `DAILY_DRIPS` transactions in the window the next request gets 429, a `retry-after` from the oldest one, and nothing sent; one under the cap sends; transactions older than the window do not count; a history too long to page through refuses; the literal value of the cap is pinned; a refused request reads no history; the log line holds the mark and agent, never the raw address, and the mark changes with the day and with the caller; a control character in the user-agent does not reach the log. The drip amount and every existing limit stay as they are.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Touch only `services/faucet`. No new production dependency. Tests never use the network.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
