# Job: Research a world-class live page for the agent economy

The owner wants a public page that shows Solive working live on devnet, so a visitor understands what it is and tries it. Two draft specs exist in this repository: `examples/jobs/live-feed/SPEC.md` (the data feed) and `examples/jobs/live-site/SPEC.md` (the page). Before anything is built, research what such a page should be, and whether the drafts are right.

## Research

1. **Best in class.** Study at least 10 live or near-live public pages that show an on-chain or agent economy at work: block explorers and activity feeds (for example Solana explorers, Etherscan), analytics (for example Dune or L2Beat dashboards), agent marketplaces and networks (for example Olas, Fetch.ai Agentverse, Virtuals, other AI-agent economies), and well-known live product pages and status pages (for example Stripe's or GitHub's). For each: what it shows first, what makes it feel alive, how it explains itself, how it turns a visitor into a user, and what it does badly. Cite each with its url and the date you looked.
2. **What matters for an agent economy.** Which numbers and events tell a newcomer that real work is being hired, delivered, judged and paid, and which are noise or vanity. What a skeptical developer wants to verify (for example a link to the escrow, the spec, the verdict and the release on chain).
3. **Data on devnet.** What the page can really read from Solana devnet for this program, and at what cost: the program's accounts and their sizes, which events live in transaction logs, the RPC calls each view needs, public devnet rate limits from one IP, websocket subscriptions, and free indexer options (for example Helius or Triton free tiers) with their limits and terms. Measure a few real reads against devnet (read only, small and spaced out, since other services on this machine share the IP) and report times and call counts.
4. **Architecture.** How to serve it so it stays fast and within limits: caching on Vercel (function cache, CDN headers, a cron that snapshots, or a small store), what happens when devnet is slow, and what the page shows then. Include the Vercel Hobby terms that apply to a public non-commercial page.
5. **Trust and safety.** Specs, memos and deliveries are untrusted text; how the best pages show user-provided text safely, or avoid it.
6. **Design.** What layout, typography, motion and density make such a page clear and credible on desktop and on a phone, light and dark, and accessible. Name concrete references.

## Deliver

One `git format-patch` file that adds a new page named live-page.md under `docs/maintainers/` with: the best-in-class table with citations, the measured devnet reads, the recommended architecture, the recommended content of the page in order with why, the trust rules, the design direction, and a section "Changes to the draft specs" listing exactly what to change in the two draft specs (or why they are right). Paragraphs under 80 words. No code. Announce the patch's sha256 to the judge.

## Rules

- Follow `CONTRIBUTING.md`. Never name a private tool.
- Read only on devnet: no key, no signing, no sends.

## Acceptance

1. Every claim about another product cites a url; every devnet number comes from a measurement you name.
2. The recommendations map to the research, and the "Changes to the draft specs" section is specific enough to edit the specs from.
