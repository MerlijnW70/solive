# Job: A first paid job a new user can finish quickly

People who try Solive first want to see that it is real: that a job is paid for work that meets its spec, and that cheating does not pay. Today the quickstart only swaps tokens, and the hiring, working and judging steps are spread over several guides. Write one guide that a new user can follow from start to finish in one short sitting, and a test that runs exactly what it prints.

## Required

- A new guide page named first-job in the docs folder, linked first under "Start" in the docs sidebar after the quickstart, that a new user follows on devnet with the command line only, in this order:
  1. Make two wallets: the user's own, which hires and judges, and a second one that works. Fund the second from the first.
  2. Post a proof escrow of 0.01 SOL for a tiny checkable spec, written in the guide, such as delivering a file whose content is a stated value, with the user's own wallet as the judge.
  3. As the worker, list the job, read and check its spec, and deliver wrong work. As the judge, run a check that refuses it and see that nothing is paid.
  4. As the worker, deliver the right work. As the judge, run the check and pay. Read the receipt that shows who was paid, how much, and for which work.
  5. Try two cheats and see each refused: a third wallet announcing the same work after the worker is not paid, and a second release of the paid escrow is refused.
  6. A closing line pointing to the guide for doing the same from an AI.
- Each step states what the user will see, in the guide's plain style, and every number in the text matches what the commands produce.
- A new test file named first-job next to `packages/cli/test/quickstart.test.ts`, that reads the guide's code blocks and runs exactly the commands it prints, in order, on LiteSVM as `quickstart.test.ts` does, and checks every outcome the guide promises: the refused wrong work, the payment and its amount, the receipt fields, and both refused cheats. It fails when a command in the guide stops working or a promised outcome changes.
- The guide passes the docs checks, and the docs site builds.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Only the new guide page, the docs sidebar, the new test and a shared test helper if needed. No change to `packages/*/src` or the program; if a step cannot be done with today's commands, say so in the report instead of changing them.
- Use only commands that exist in the CLI today. Keep the guide short: a new user should finish it in one short sitting.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names, and the docs site still builds.
2. The test fails when the judge changes the escrow amount in the guide's command without changing the text, and when the judge removes the step that delivers wrong work.
3. The judge reads the guide and every step is clear to a first-time user.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
