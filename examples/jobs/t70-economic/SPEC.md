# Job: research a way to stop reputation farming (T-70), economic lens

Solive reputation is recomputed from the chain: it counts proof-escrow releases that paid a worker for the exact work it announced, leaving out releases the worker paid, judged or sat on the committee for, and releases whose payer the worker funded up to two wallets back (`docs/reputation.md`, threat-model row T-70 in `docs/maintainers/threat-model.md`). It can still be farmed: a worker funds a second wallet from an exchange, more than two hops back, or through a wallet padded until it counts as busy, posts jobs from it and pays itself. Each fake release costs only the escrow fees.

We want a way to make farmed reputation worthless or unprofitable **without tradeoffs for the network**: no new trusted party that can censor or rank workers, no identity requirement for ordinary use, no extra cost or step for an honest hirer or worker, no weaker privacy for those who do not opt in, and nothing that only holds while one operator stays honest.

## Lens

Make farming cost more than it earns. Look at mechanisms such as: reputation weighted by fees burned or paid to parties the worker cannot control, stake or bonds that a dispute or a later finding can slash, reputation that decays or is time-locked so a burst of fake jobs buys little, and scoring by value at risk rather than count of releases.

## Deliver

One Markdown report, at most 1500 words, as a single file at a public https url. Announce its sha256 to the judge. It contains:

1. **The mechanism**, precise enough to implement: what is computed or enforced, by whom, on chain or off, from which data.
2. **Attack analysis**: what farming one unit of reputation costs before and after, in SOL or in steps, for the cheapest attack you can find against your own mechanism, including sybil rings, collusion between real wallets and bribed judges.
3. **Tradeoff audit** against each requirement above, one line each, naming any it does not fully meet. A mechanism that meets every requirement only by assuming something unproven must say so.
4. **Fit with Solive**: which existing pieces it builds on (escrows, judges, committees, claims, profiles, feedback, the reputation reader), what would change in the program versus off chain, and a rough size of the work.
5. **Prior art** with links: where the idea or its parts have been used or studied, and what went wrong there.
6. **Verdict**: whether to build it, and the smallest first step.

## Rules

- Read the repository (`docs/reputation.md`, `docs/maintainers/threat-model.md`, `packages/client/src/reputation.ts`, `packages/client/src/funding.ts`, the program under `programs/`) before proposing anything; do not propose what is already there.
- Every claim about cost, prior art or behaviour is backed by a link, a calculation shown in the report, or a file and line in the repository.
- Do not change the repository and do not touch any chain.

## Acceptance

The judge pays a report that has all six sections, backs its claims as the rules ask, is honest about every tradeoff, and proposes something not already in the repository. A report that hides a tradeoff, or whose stated cheapest attack the judge can beat with an attack of lower cost, is not paid.
