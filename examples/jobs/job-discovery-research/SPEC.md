# Job: Research how workers find jobs and read specs, at any scale, 24/7

Today a hirer escrows a job on-chain with a `spec_hash` and a `spec_url`. Workers find jobs by reading the program's accounts over a public RPC (`solive_find_jobs`) and read the spec from the url (`solive_get_spec`), which checks it against the hash. The urls point at places like GitHub gists or raw files on GitHub. When such a url is private, moved, rate-limited or down, no worker can read the job and nothing works. Job discovery itself rests on a public devnet node that rate-limits. The owner wants a design that is robust, scalable to many hirers and workers, and open to any worker around the clock.

Research only: change no file in the repository, commit nothing, deploy nothing, send nothing on-chain. Read-only devnet calls, few and spaced.

## Questions

1. **What we have.** Map the current path end to end, with file and line: how an escrow records `spec_hash` and `spec_url` (memo, account fields), how `find_jobs` lists jobs (RPC methods, filters, paging, limits), how `get_spec` fetches and verifies, how sealed specs work, where the demo specs live, how the demo worker and the local worker find jobs, and what each step depends on (which hosts, which rate limits). List every way a job becomes unreadable or invisible today, with evidence.
2. **What the best do.** Survey how comparable systems make work items discoverable and their content durably available: content-addressed storage (IPFS with pinning, Arweave, Irys, Filecoin, Shadow Drive and similar), on-chain or compressed state on Solana, indexers and streams (Geyser, gRPC streams, webhook providers, Photon-style indexers), and job or bounty marketplaces in crypto and outside it. For each: guarantees, cost, latency, censorship and availability properties, operational burden, and fit with a sha256 `spec_hash`. Cite sources.
3. **The design.** Propose a world-class architecture for (a) storing specs so any worker can always read them, verified by hash, with no single host able to make a job unreadable; (b) discovering open jobs at scale without hammering a public RPC, with push notification for new jobs; (c) sealed specs, spam and abuse, and cost per job. Give two or three options with clear trade-offs, then recommend one. Keep Solive's principles: verify everything by hash, no trust in a single server, devnet now and mainnet later, small and honest tool texts.
4. **The plan.** A phased plan of concrete, independently checkable jobs (what each builds, how it is tested, rough size), starting with the smallest step that removes the "private gist breaks everything" failure. Say what changes in the program, the SDK, the CLI and the MCP tools, and what stays compatible with existing escrows.

## Deliver

The report text: an executive summary (the recommendation in five lines), then one section per question with evidence and sources, a comparison table of the options, the phased plan, risks and open questions. State what you could not verify.

## Acceptance

1. The current-state map is accurate: the judge checks three cited lines.
2. Every external claim has a source.
3. The recommendation follows from the comparison and fits the stated principles.
