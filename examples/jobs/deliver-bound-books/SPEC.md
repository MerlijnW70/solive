# Job: Delivery sends match their preview, and delivery books are closed (H2)

**Rules:**
1. Every wallet send whose cost can change between preview and send is bound to the preview's approval.
2. Every account a wallet paid for can be closed back to that wallet through the tools.

The review of F1 found two gaps.

`wallet_deliver` (`packages/cli/src/agent/wallet/delivery.ts`) reads the announce fee again at send time, without an approval. A send can therefore pay a different announce fee than the preview showed. `prepare_deliver` in the same file reads the fee the same way.

No reclaim path closes the delivery book a wallet paid for, so that book's rent is stranded:
- `wallet_reclaim` (`agent/wallet/refute.ts`)
- CLI `announce reclaim` (`announce-commands.ts`)
- client `plan.reclaim` (`packages/client/src/announcement-sends.ts`)

## Build

1. **Find every unbound send.** Search every wallet tool that sends with `send: true` but takes no approval. List each one, and state whether any figure it pays can change between preview and send. Bind each such send to its preview, the way `wallet_escrow` and `wallet_worker` do.
2. **Close the book on reclaim.** When the last live announcement closes, `plan.reclaim` closes the delivery book in the same flow and returns its rent to its recorded payer. Batch the closes the way the F1 worker return does. A book refused by the program must not block the rest of the reclaim. Use the plan in `wallet_reclaim` and in CLI `announce reclaim`.

## Tests

- A `wallet_deliver` send after a raised announce fee is refused, and nothing is sent.
- A send carrying the preview's approval pays exactly the figure that preview showed.
- A reclaim that closes the last announcement also closes the book and returns its rent to the payer. This holds for the client plan, the MCP tool and the CLI.
- A book the program refuses to close is listed. The remaining announcements still close.
- Each new test fails without its fix.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Change only the files named here, the files step 1 finds, their tests and the generated references. No program change.
- Run only the tests you touch, plus typecheck, lint and the docs checks. The judge runs the full CI.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
