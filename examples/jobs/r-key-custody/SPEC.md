# Job: research hardware keys for judges, fillers and wallets (T-55, T-57, T-62, T-56)

Role keys are files on one machine (threat-model rows T-55, T-57, T-62, T-56). A judge cannot sign with a Ledger because every release carries an Ed25519 instruction over a message the judge signs (`packages/client/src/client-settle.ts`, `programs/intent_engine/src/attested.rs`), and the Ledger signer only signs transactions (`packages/client/src/ledger.ts`). The filler's inventory and fee key are one key, and the MCP wallet reads a key file. Find the design that puts each of these keys on a hardware or otherwise isolated signer: for example the Ledger Solana app's off-chain message format verified by the program, a judge that signs a transaction instead of a message, a hot filler key with a capped float refilled from a cold key, or an MCP wallet backed by a Ledger.

We want a fix **without tradeoffs for the network**: no new trusted party that can censor or rank workers, no identity requirement for ordinary use, no extra cost or step for an honest hirer or worker, no weaker privacy for those who do not opt in, and nothing that only holds while one operator stays honest. Solive has no users yet, so program changes and breaking changes are allowed.

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
