# Job: A local worker returns everything it holds, and its send matches its preview (F1)

The deep audit (A2 W4, W10) found that `wallet_worker` strands the delivery book's rent when it returns leftovers, and that its send is not bound to the preview the user approved.

## Build

1. **No stranded rent.** `fundingOf` (`agent/wallet/worker.ts`) funds the worker with the delivery book's rent. The program records the announcing payer, the worker, as the book's payer and returns the rent there when the book closes. `returnLeftovers` (`agent/wallet/worker-return.ts`) never closes or lists the book, `holdsNothing` ignores it, and the key file is deleted while the summary says it is deleted "once it holds nothing". Close the book before deleting the key when it can be closed. When it cannot be closed yet, keep the key and list the book as kept, with what is needed to close it later. The summary must say which of the two happened.
2. **Send bound to its preview.** On send, `worker.ts` runs `fundingOf` again with no approval, so the amount sent can differ from the amount previewed, for example after the announce fee changed. Give the preview an approval over the funding it shows. Refuse a send whose approval is missing or whose funding differs, the way other wallet tools do.

## Tests

Each item has a test that fails without its fix:
- `return_leftovers` after an announcement either closes the book and returns its rent, or keeps the key and lists the book.
- A key is never deleted while a book it paid for is open.
- A send after a changed announce fee is refused and sends nothing.
- A send with the preview's approval sends the previewed amount.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only `packages/cli/src/agent/wallet/worker.ts`, `packages/cli/src/agent/wallet/worker-return.ts`, a new helper file beside them if needed, their tests and generated references. No program change.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
