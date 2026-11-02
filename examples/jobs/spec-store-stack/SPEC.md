# Job: Research how to build the hash-addressed spec store and job discovery in this codebase

A research job recommended making job specs readable by their `spec_hash` from several sources (the memo url, Solive mirrors at `/sha256/<hex>`, IPFS trustless gateways via a CID derived from the hash, Arweave), publishing specs to those sources when an escrow is made, filtering job discovery by kind and status with push through account subscriptions, and later open job feeds verified against the chain. Its report is in `F:\solive-kit\kill-wave\job-discovery-research\report.md`. Now decide how to build each part well in this repository.

Research only: change no file in the repository, commit nothing, deploy nothing, send nothing on-chain.

## Questions

1. **The codebase as it is.** Map the languages, packages and services that exist today and how they are built, tested, guarded and deployed: the Rust program and crates (`programs/`, `crates/`), the TypeScript packages (`packages/core`, `client`, `solver`, `cli`, `multisig`), the services (`services/faucet`, `services/live`) on Vercel, the WSL services (filler, demo worker), CI (`scripts/ci.sh`, `.github/workflows/`), mutation testing, file-size and no-comment rules, and how releases reach npm. Cite files.
2. **Per component, the best stack.** For each part of the plan (client fallback and CID derivation; the mirror service with its "only bytes whose hash matches an existing escrow" rule; publishing to Arweave and IPFS; filtered discovery, caching and subscriptions; an open job feed that indexes the program and serves SSE/JSON), compare realistic choices: TypeScript in the existing packages, a Vercel function with Blob or another store, a Rust service (for example on Yellowstone gRPC or a websocket indexer), a Cloudflare Worker with R2, or another option. Weigh fit with the existing code and tests, reuse of the existing decoders and SDK, performance and cost at scale, operational burden, security (abuse, SSRF, storage limits), portability between devnet and mainnet, and how well each can be tested and mutation-tested here. Cite sources for any external library or service claim, with versions.
3. **Libraries.** Name the concrete libraries per choice (for example for CID and multihash, Arweave or Turbo uploads, IPFS pinning, Yellowstone clients), with maintenance status, licence, size and whether they fit the repository's supply-chain checks (`scripts/supply-chain.sh`, `cargo deny`, `pnpm audit`).
4. **Recommendation and build order.** One recommended stack per component, with the reason, and the order to build them as independent jobs, each with its interfaces (types, endpoints) sketched precisely enough that separate workers can build them in parallel without conflicts.

## Deliver

The report text: a short executive summary (the stack per component in one line each), then one section per question with evidence, a comparison table per component, the build order with interfaces, risks, and what you could not verify.

## Acceptance

1. The codebase map is accurate: the judge checks three cited files.
2. Every external claim has a source and a version where it matters.
3. The recommendation follows from the comparison and fits the repository's rules.
