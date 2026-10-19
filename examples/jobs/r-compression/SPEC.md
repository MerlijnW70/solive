# Job: research ZK compression and state compression for scalable Solive escrows and accounts

Every Solive intent, claim board, stand-by entry, profile, mandate and committee is a regular rent-paying account (`programs/intent_engine/src/state.rs`), and every escrow holds tokens in a vault token account. Rent is refunded on close, but it is capital locked per job and caps how many open jobs a user can afford. Research whether ZK compression (Light Protocol compressed accounts and compressed tokens), state compression (concurrent Merkle trees, as used for compressed NFTs) or similar middleware should hold some of this state. For each account type, say whether it fits, what it saves in rent and lamports per job with the arithmetic shown, what it costs in compute, transaction size and proof fetching, which indexer or prover the program and clients would depend on, what happens when that indexer is down or lies, how it interacts with our verifiable builds, multisig upgrades and account versions, and whether escrowed token custody can safely move to compressed tokens. End with which account types (if any) to compress first and the smallest first step.

Judge every option against Solive's own rules: no new trusted party that can censor or rank users, nothing that only holds while one operator stays honest, no extra cost or step for an honest hirer, worker or solver who does not opt in, and no weaker security for the escrow money. Name every third-party dependency (provider, validator client, RPC feature) and what happens when it is down or lies.

## Deliver

One Markdown report, at most 1500 words, as a single file at a public https url. Announce its sha256 to the judge. It contains:

1. **The mechanism**, precise enough to implement: what is computed or enforced, by whom, on chain or off, from which data.
2. **Attack analysis**: the cheapest way your proposal can fail or be abused, and what it costs before and after in SOL, latency or steps.
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
