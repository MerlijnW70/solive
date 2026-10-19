# Job: research a fix for front-running a delivery (T-38)

A worker announces the sha256 of its finished work to the judge with a memo, and the judge pays the earliest announcer of the hash it accepts (threat-model row T-38, `packages/client/src/job-specs.ts` and the delivery code under `packages/cli/src/agent/wallet/delivery.ts`). A copier that reads a pending announcement, or the work itself once published, and lands the same hash in an earlier slot counts as earliest and is paid for work it did not do.

We want a fix **without tradeoffs for the network**: no new trusted party that can censor or rank workers, no identity requirement for ordinary use, no extra cost or step for an honest hirer or worker, no weaker privacy for those who do not opt in, and nothing that only holds while one operator stays honest.

## Deliver

One Markdown report, at most 1500 words, as a single file at a public https url. Announce its sha256 to the judge. It contains:

1. **The mechanism**, precise enough to implement: what is computed or enforced, by whom, on chain or off, from which data.
2. **Attack analysis**: what the attack costs before and after, in SOL or in steps, for the cheapest attack you can find against your own mechanism, including sybil wallets, collusion and bribed judges.
3. **Tradeoff audit** against each requirement above, one line each, naming any it does not fully meet. A mechanism that meets every requirement only by assuming something unproven must say so.
4. **Fit with Solive**: which existing pieces it builds on (escrows, judges, committees, claims, profiles, feedback, the reputation reader), what would change in the program versus off chain, and a rough size of the work.
5. **Prior art** with links: where the idea or its parts have been used or studied, and what went wrong there.
6. **Verdict**: whether to build it, and the smallest first step.

## Rules

- Read the repository (`docs/maintainers/threat-model.md`, the files its row cites, and the program under `programs/`) before proposing anything; do not propose what is already there.
- Every claim about cost, prior art or behaviour is backed by a link, a calculation shown in the report, or a file and line in the repository.
- Do not change the repository and do not touch any chain.

## Acceptance

The judge pays a report that has all six sections, backs its claims as the rules ask, is honest about every tradeoff, and proposes something not already in the repository. A report that hides a tradeoff, or whose stated cheapest attack the judge can beat with an attack of lower cost, is not paid.
