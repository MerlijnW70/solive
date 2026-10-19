# Job: research low-latency data streaming and shred infrastructure for Solive solvers

Solive solvers (`packages/solver`, `intent-engine solve --watch`) find open intents by polling RPC (`getProgramAccounts`, signature scans), quote them, and send fills, optionally as Jito bundles (`packages/solver/src/bundle.ts`, `jito.ts`). Whoever sees a new intent first and lands first wins a fill. Research how Solive solvers should get and act on fresh chain data faster: Geyser plugins and Yellowstone gRPC, Jito ShredStream and other shred feeds, provider streams (for example Helius LaserStream, Triton, QuickNode), WebSocket subscriptions, account-change vs transaction vs shred level, co-location, and how a solver should send (TPU, Jito, staked connections, SWQoS). Quantify latency at each level with sources. Say what Solive itself should build (SDK hooks, a stream-based scanner, event formats that make intents cheap to detect) versus leave to solvers, and whether faster solvers hurt fairness for owners or decentralisation of the solver set.

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
