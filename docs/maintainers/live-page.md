# Live page

Research for a public page that shows Solive working live on devnet, done on 2026-10-31 against the two drafts at `examples/jobs/live-feed/SPEC.md` and `examples/jobs/live-site/SPEC.md`. Every claim about another product cites the page and the date it was read. Every devnet number names the measurement it comes from; the measurements are listed under [Measured devnet reads](#measured-devnet-reads).

## Top recommendations

1. Lead with proof, not totals: one card that walks the newest paid job through its three transactions (escrow, delivery, release), each a link to devnet, with the spec hash the escrow pins.
2. Merge "verdict" and "payout" into one "release" kind. On chain they are the same transaction (M7), and a failed verdict leaves no trace at all.
3. Mark house activity. The demo worker, the filler and self-judged jobs are real transactions but not a market; label them and count them apart.
4. Read events from inner instructions. The program emits every event through a self-call, so transaction logs carry none of them (M7); the feed has to fetch transactions.
5. Read incrementally and keep state in the Vercel Runtime Cache. Devnet activity is sparse (M6: the newest 200 program transactions reach back from 2026-10-31 05:52 to 2026-10-29 21:22 UTC), so most refreshes are one call.
6. Let the visitor make the page move: activity is too sparse to look alive on its own, but a demo job a visitor posts is delivered within a minute and shows up in the stream.
7. Show no user-written text at all: specs, memos, deliveries and profile fields stay off the page.
8. Fix the draft contract: a `stale` field the schema lacks, an `unknown` service state the enum lacks, per-token totals, and a `house` flag.
9. A restrained, data-first design with one type family, lifecycle colours that always carry a text label, no looping motion, and a pause control on the stream.

## Best in class

Each page was read on 2026-10-31. Several are client-rendered and showed only "Loading…" to a text fetch; the table says so where it matters, because a page that needs a script to show its first number is a lesson too.

| Page | Shows first | Feels alive through | Explains itself by | Turns a visitor into a user by | Does badly |
| --- | --- | --- | --- | --- | --- |
| [Etherscan](https://etherscan.io/) | ETH price and gas in a top bar, a search box, then six stats (price, market cap, transactions with TPS, gas, last finalized and safe block) | "Latest Blocks" and "Latest Transactions" lists with relative times in seconds | Labels only; every row links to a full record | Search; every hash is a link a skeptic can follow | Two "Ad" slots, one directly under the search box; price first, which says nothing about the chain working |
| [mempool.space](https://mempool.space/) | Fee tiers ("No Priority" to "High Priority") in sat/vB, then difficulty, mempool size, replacements, recent transactions | Unconfirmed count ("49,629 TXs"), memory use, recent replacements that change between visits | A "Learn" block with FAQ entries such as "What is a mempool?" and API documentation | Answers the question a user arrives with: what fee to pay now | Dense for a newcomer; terms are not defined inline |
| [ultrasound.money](https://ultrasound.money/) | ETH supply over a selectable window (5m to 30d), burn and issuance | "updated … ago" stamps beside panels | A q&a section and a written formula: "supply = EVM balances + beacon chain balances - beacon chain deposits" | A strong voice and a meme with a dated origin timeline | Playful lowercase voice is a taste choice that does not travel; first render shows "loading..." |
| [L2BEAT summary](https://l2beat.com/scaling/summary) and [stages](https://l2beat.com/stages) | Every project with category, stage and host chain, for example "Optimistic Rollup, Stage 1, Arbitrum, on Ethereum" | A maintained, current index rather than motion | A public framework: Stage 0 is "fully controlled by few entities", Stage 2 "fully controlled by code" | Trust: it states that a stage is about decentralization, "not in terms of security" | The index itself carries no definitions; meaning lives one click away |
| [Dune discover](https://dune.com/discover/content/trending) and [dashboard docs](https://docs.dune.com/web-app/dashboards) | Trending dashboards as cards with creator, age and tags | Community activity; queries behind every chart | The query is the explanation; forking it is the verification | Fork a dashboard and edit its query | Dashboards "are not updated automatically" per the docs; card counts are unlabelled |
| [Olas](https://olas.network/) | "Co-own AI", then press logos, then two products, then a metrics grid | Totals: "Agents deployed: 3,784", "Daily Active Agents: 456", "A2A txns: 14,911,627", "turnover: $110,497.59" | A flywheel graphic and prose | "Own Your Agent", "Monetize Your Agent" | Lifetime totals next to a placeholder: "OLAS burned: $0", which the page itself calls "a placeholder rather than a measurement" |
| [Virtuals](https://app.virtuals.io/) with [Forkast on ACP](https://forkast.news/the-machine-as-buyer-virtuals-acp-and-the-evaluator-problem/) | The app returned only its title to a text fetch | Agent market caps (not visible without scripts) | An escrow plus evaluator protocol, close to Solive's model | Token launches | Forkast (2026-07-22) calls the $470 million aGDP and 1.77 million jobs "self-reported" and says "Incentives make it profitable to simulate commerce" |
| [Fetch.ai Agentverse](https://agentverse.ai/) | The site refused a text fetch with HTTP 403 | Registered-agent counts | Directory pages | Agent search | Counts of registered agents ([about 2.7 million](https://www.finanztrends.de/news/fetch-ai-27-millionen-agenten-im-netzwerk/)) against [36,338](https://hol.org/blog/state-of-ai-agents-march-2026) in one third-party index: a registration number is not activity |
| [GitHub Status](https://www.githubstatus.com/) | "All Systems Operational", then a component list | "Uptime over the past 90 days" bars and dated incidents with "Investigating", "Monitoring", "Resolved" | A legend for each bar state, including "No data exists for this day" | Subscribe by email, text, Slack, webhook, Atom or RSS | Little; the "no data" state is named instead of hidden, which the live page should copy |
| [Stripe status](https://status.stripe.com/) and [stripe.com](https://stripe.com/) | Status showed only "Loading..."; the home page leads with static figures such as "99,999%" uptime | Nothing live in the text render | Customer stories and large figures | "Start nu", "Contact opnemen met sales" | A status page that needs a script to say whether Stripe is up |
| [Railway](https://railway.com/) | To a text fetch, a page for agents: "You are an AI agent reading railway.com" | Nothing live | Imperative setup steps | One command: `railway up -y` | Nothing for a human reading the same fetch; worth noting because Solive's visitors include agents |
| [Fly.io](https://fly.io/) | "deploy apps and agents on fast, hardware-isolated VMs" | Nothing live | Short, direct copy ("No Dockerfile? No problem") | `fly launch` under "Get started" | The command sits below the fold |
| [Tailwind CSS](https://tailwindcss.com/) | "Rapidly build modern websites without ever leaving your HTML." | Real markup next to its rendered result | Showing, not telling: every claim is a working example | "Get started" | Long; the install is a click away, not on the page |
| [Raycast](https://www.raycast.com/) | "Your shortcut to everything." | Real UI captures of each feature | Feature-by-feature screenshots | "Get started", "Browse the store" | The headline could describe many products |
| [Vercel](https://vercel.com/) | "Agentic Infrastructure" | Nothing live in the text render | Feature lists and three customer stories | "Deploy now" and a CLI command for deploying without an account | A two-word headline that names a category, not a result |

Lessons the table supports:

- The best verification pages (Etherscan, Dune, L2BEAT) make every number one click from its source.
- Status pages earn trust by naming "no data" and incidents instead of hiding them (GitHub Status).
- Lifetime totals and registration counts are the weakest signal on agent sites (Olas, Agentverse), and critics already call them simulated (Forkast on Virtuals).
- Developer pages that convert put one runnable line close to the top (Railway, Fly.io, Vercel).
- Client-only rendering fails readers without scripts, including agents (Stripe status, Virtuals); the live page should carry its explanation and its try-it lines in the HTML itself.

## What matters for an agent economy

A newcomer believes the economy is real when one job shows its whole life: someone locked money for a pinned spec, a worker delivered, a judge approved, and the escrow paid that worker. Totals come second, and only counts over a short window: jobs paid in the last 7 days, distinct paid workers, open jobs now. Lifetime volume, registered agents and token prices are noise for this question, as the Olas and Agentverse rows show.

A skeptical developer wants the whole chain on chain: the escrow transaction, the spec hash the escrow pins (with the public spec beside it when the spec is a known demo), the delivery announcement with its commitment, and the release that names the judge and pays the payee in the same transaction. The page should offer exactly those three links and a one-line command to check a job locally, because Dune's lesson is that the query is the proof.

House activity needs its own label. The demo worker and the filler run on this machine, and a hirer that judges its own job proves the flow but not a market. Forkast's critique of Virtuals is that unlabelled self-activity reads as simulated commerce. The page wins credibility by saying, per row and in the totals, which activity is house and which is outside.

Signals worth showing, in order: the newest complete paid job; jobs paid in 7 days, split house and outside; open jobs with their escrowed amount per token; distinct paid workers; the median time from escrow to release; refunds and expiries, because a market that never refunds looks staged. Noise: lifetime totals, transaction counts, failed transactions, swaps by the filler presented as demand.

## Data on devnet

The program is `GHFB9q4fhhqRyCoycoivdxMhFkp1aLHJk5VvroUsgrJU` (from `declare_id!` in `programs/intent_engine/src/lib.rs`). Its accounts are zero-copy with an 8-byte discriminator; the sizes below come from the generated account sizes in `packages/core/generated/client/accounts/` and match the `space` that devnet reported in measurement M3.

| Account | Size in bytes | Count on devnet (M3) | What the page reads from it |
| --- | --- | --- | --- |
| intent | 464 | 80 | open jobs and swaps: owner, kind, escrowed amount, expiry, spec hash and attestor in the params |
| announcement | 920 | 267 | a delivery: worker, commitment, slot |
| delivery book | 96 | 253 | the next sequence number per job |
| user state | 152 | 176 | nothing for the page |
| claim board | 176 | 37 | how many workers claimed a job |
| mandate | 384 | 9 | nothing for the page |
| committee | 408 | 1 | committee members of a judged job |
| profile | 504 | 1 | nothing: its skills and urls are user text |
| claim list | 1104 | 1 | nothing for the page |
| config | 536 | 1 | pause flags, for a "paused" banner |

Events are emitted with Anchor's `emit_cpi!`, all of them (`programs/intent_engine/src/instructions/`). They arrive as an inner instruction to the program itself whose data starts with Anchor's 8-byte event tag (`e445a52e51cb9a1d`), not as "Program data:" log lines. Measurement M7 decoded 12 events from the inner instructions of 10 transactions and found no "Program data:" line in their logs. So a `logsSubscribe` stream or a log scan cannot build the feed; every event costs a `getTransaction`. `@intent-engine/core` already parses each event (`packages/core/src/events.ts`).

| Feed kind | Program event | Where the amount and party come from |
| --- | --- | --- |
| escrow | `IntentCreated` with the attested-result kind | `escrowed`, `owner`, input mint; the spec hash and attestor from the intent's params |
| claim | `JobClaimed` | `worker`, `stake` |
| delivery | `DeliveryAnnounced` | `worker`, `attestor`, `commitment` |
| release | `DeliveryReleased` with `IntentAttested`, or with `IntentSplit` and `ShareHeld` for a split; `CommitteeAttested` adds the committee's `signers` | `attestor`, `payee`, `net` |
| refund | `IntentCancelled`, `IntentExpired` | `refunded`, `owner` |
| swap | `IntentFilled` for swap, limit and auction kinds | `solver`, `amount_in`, `delivered` |

M7 found `DeliveryReleased` and `IntentAttested` together in both release transactions it read: the verdict and the payout are one transaction. Committee votes are signatures the release carries, not transactions of their own.

A judge rejects work by not releasing it, so a failed verdict leaves nothing on chain. The page can show releases and refunds, never an on-chain "rejected", and the contract should not promise a separate verdict event. `AgentPaid` is a mandate agent's fee, not a worker's pay, and `IntentClosed` is rent cleanup; both stay out of the stream.

### RPC calls per view

| View | Calls | Measurement |
| --- | --- | --- |
| new activity since the last refresh | one `getSignaturesForAddress` on the program with `until` set to the newest signature already seen | M6 |
| events for those signatures | one `getTransaction` each, capped per refresh | M7 |
| open jobs and their escrowed amounts | one `getProgramAccounts` with a discriminator filter on intent accounts | M4 |
| all accounts by type, for counts | one `getProgramAccounts` with a data slice of the discriminator only | M3 |
| service lights | one `getSignaturesForAddress` with a limit of 1 per house wallet, and one HTTP GET to the faucet | not measured; same method as M6 |

### Measured devnet reads

All reads went to the public devnet endpoint from this machine, read only, with a pause of several seconds between calls, on 2026-10-31 between 05:54 and 06:17 UTC, in three runs of one Node.js script that timed each request. The filler, the demo worker and the faucet share the same IP, so the remaining budget in the headers reflects their use too. Times are wall-clock milliseconds per request; sizes are bytes of the JSON answer.

| Id | Call | Status | Time | Size | Result |
| --- | --- | --- | --- | --- | --- |
| M1 | `getVersion`, first request on a cold connection | 200 | 191 | 90 | |
| M2 | `getSlot` | 200 | 24 | 44 | |
| M3 | `getProgramAccounts`, all, data slice of the discriminator only | 200 | 60 | 198,814 | 826 accounts |
| M4 | `getProgramAccounts`, intent accounts, full | 200 | 36 | 67,949 | 80 accounts |
| M4b | `getProgramAccounts`, announcement accounts, full | 200 | 72 | 389,039 | 267 accounts |
| M5 | `getSignaturesForAddress`, limit 1000 | 429 | 21 | 107 | `retry-after: 10`, "Too many requests for a specific RPC call" |
| M6 | `getSignaturesForAddress`, limit 200, in two later runs | 200 | 202 and 216 | 46,271 | newest at 2026-10-31 05:52:14, oldest at 2026-10-29 21:22:15; none failed; 13 with a memo |
| M7 | `getTransaction` for the 10 newest, one at a time | 200 | 111 to 134 | 3,352 to 7,657 | events `IntentCreated` 4, `IntentClosed` 2, `DeliveryAnnounced` 2, `DeliveryReleased` 2, `IntentAttested` 2; no "Program data:" log line |
| M8 | websocket: `logsSubscribe` mentioning the program and `programSubscribe` with a discriminator slice, in three sessions between 05:55 and 06:08 | accepted | 121 to 123 to open | | no notification in any session, matching no program transaction after 05:52:14 |

Every answer carried rate-limit headers. On 2026-10-31 they said: `x-ratelimit-tier: free`, `x-ratelimit-rps-limit: 250`, `x-ratelimit-conn-limit: 40`, `x-ratelimit-pubsub-limit: 10`, and `x-ratelimit-method-limit` of 150 for light calls but 10 for `getProgramAccounts` and `getSignaturesForAddress`.

In M3 to M5 the remaining count of that heavy bucket fell 8, 7, 1, then -5 across four consecutive calls of this script between 05:54:56 and 05:55:05 UTC, with a pause before each; the other services on the IP used the rest. The [Solana cluster docs](https://solana.com/docs/references/clusters) state other figures, 100 requests per IP and 40 for any one method in the same window, and warn that the limits change without notice; the headers are the truth to code against.

Two conclusions follow. The heavy bucket of 10 is the binding limit, not requests per second; a feed that calls `getProgramAccounts` and `getSignaturesForAddress` on every refresh competes with the filler and the demo worker on this IP and with every other tenant on a Vercel egress IP. And the feed must honour `retry-after` and serve its last snapshot instead of retrying.

Activity is sparse. M6's 200 newest program transactions reach back from Saturday 05:52 to Thursday 21:22 UTC, about six an hour, and M8 heard nothing in any of its sessions. A stream of 50 events therefore covers most of a day, a refresh every `FEED_MAX_AGE_SECS` finds nothing new almost every time, and a websocket would sit idle.

The page cannot look busy on its own and should not pretend to; it should say when the last event happened and invite the visitor to post a demo job, which the demo worker delivers within a minute according to the MCP server's own instructions (`packages/cli/src/agent/mcp.ts`).

### Free indexers and RPC providers

| Provider | Free tier on 2026-10-31 | Devnet | Fit |
| --- | --- | --- | --- |
| [Helius](https://www.helius.dev/pricing) | 1M credits a month, 10 RPC requests per second, `getProgramAccounts` 5 per second at 10 credits each; webhooks included; `transactionSubscribe` not included | not stated for Free; [pricing.md](https://www.helius.dev/pricing.md) lists devnet gRPC only for Developer | good for a keyed `FEED_RPC_URL` if devnet is confirmed with a key |
| [Alchemy](https://www.alchemy.com/support/free-tier-details) | 30M compute units a month, 300 to 500 units per second (its own pages disagree) | a devnet endpoint `solana-devnet.g.alchemy.com` ([docs](https://www.alchemy.com/docs/reference/solana-api-quickstart.md)) | good fallback |
| [Triton](https://triton.one/pricing) | none: a $125 prepaid minimum deposit | not stated | not for this page |
| Public devnet | measured above | yes | default, behind the cache |

## Architecture

One Vercel Node.js function, `/api/feed`, in one region (Hobby allows a [single function region](https://vercel.com/docs/functions/configuring-functions/region)), and static files for the page. The function keeps a small state document: the newest signature seen, the last 50 events, 7-day counters, and the time of the last good read. It stores that document in the [Vercel Runtime Cache](https://vercel.com/docs/caching/runtime-cache) under a fixed key; that cache is available on Hobby, allows items far larger than this document, and survives deployments for keys the code chooses.

Each refresh asks only for what is new: `getSignaturesForAddress` with `until` set to the stored newest signature, then `getTransaction` for at most a fixed number of new signatures, oldest first, carrying the rest to the next refresh. `getProgramAccounts` for open jobs runs at most once every few minutes, not on every refresh. A quiet refresh is one call.

The function writes the cache only when the state changed, because Hobby includes 200K Runtime Cache write units a month, and each unit covers only a small slice of a document.

CDN caching sits in front. The response carries `Cache-Control: public, max-age=10` for browsers and `Vercel-CDN-Cache-Control: public, s-maxage=30, stale-while-revalidate=300, stale-if-error=86400` for the CDN. Vercel's [CDN cache docs](https://vercel.com/docs/caching/cdn-cache) state that it strips `s-maxage` and `stale-while-revalidate` from a plain `Cache-Control` before the browser, that it supports `stale-if-error`, and that the cache is "segmented by region", so each region misses on its own and the Runtime Cache absorbs those misses.

A Hobby cron [runs at most once per day](https://vercel.com/docs/cron-jobs/usage-and-pricing) with an hour of jitter, so a cron cannot keep the feed fresh; the request path does.

When devnet is slow, every call has a short timeout and the whole refresh a total budget; on a timeout or a 429 the function returns the stored snapshot with `stale: true` and `stale_since`, and honours `retry-after` before its next try. The page then says "Devnet is slow; showing activity as of 06:12 UTC" and keeps every link working.

Budget against Hobby's [included usage](https://vercel.com/docs/plans/hobby): 1,000,000 function invocations, 4 CPU-hours of active CPU, 1,000,000 Runtime Cache reads and 200,000 writes a month. A refresh every `FEED_MAX_AGE_SECS` of the draft in one region is 86,400 refreshes a month, inside the invocation allowance.

At M6's rate of about six program transactions an hour, writing only on change is about 4,300 writes a month, far under 200,000; writing on every refresh would not be, since a state document of 50 events counts as several write units. Active CPU counts compute, not the wait on devnet. Each extra CDN region adds at most one invocation per `FEED_MAX_AGE_SECS`.

`FEED_RPC_URL` may carry an API key in its path or query. The feed must never echo it; the response names only the cluster. The repository already redacts urls this way (`packages/client/src/redact-url.ts`).

### Hobby terms

Hobby is for "non-commercial personal use only", and commercial use includes "Advertising the sale of a product or service" and "Any method of requesting or processing payment from visitors" ([fair use guidelines](https://vercel.com/docs/limits/fair-use-guidelines)). A devnet page with test tokens, no ads, no payments and no sales pitch fits.

Asking for donations does not count as commercial. The moment the page promotes a paid offering, or anyone is paid to build or host it, it needs Pro. The owner should decide this before launch, not after.

## Content of the page, in order

1. **Top bar.** Product name from `identity.toml`, a "Devnet" badge with "test tokens, no value", and a live status in words, "Live, updated" and a relative time, with a pause button. Why: GitHub Status leads with state; WCAG 2.2.2 needs a pause for auto-updating content.
2. **Headline, one sentence and one command.** The `add-to claude` line with a copy button, and a link to the other hosts. Why: Railway, Fly.io and Vercel put the command near the top.
3. **The newest paid job.** One card, three transactions: escrow, delivery, and the release in which the judge's verdict pays the worker, each with time, party, amount and a devnet explorer link, plus the spec hash and the spec name when it is a known demo. Why: the skeptic's chain; Etherscan and Dune make the record one click away.
4. **Four numbers.** Open jobs, jobs paid in 7 days, paid in 7 days per token, distinct paid workers in 7 days, each split "outside / house". Why: short windows over lifetime totals (Olas, Agentverse).
5. **The live stream.** Newest first, at most 50 rows, each with a kind label and icon, the feed's own sentence, the party, the amount, a relative time and the explorer link; house rows marked. Why: Etherscan's latest lists and mempool.space's recent transactions are what makes those pages feel alive.
6. **How it works.** The same three steps as the card, as a labelled diagram, with a link to the docs. Why: the explanation sits next to its live example, as in Tailwind.
7. **Try it.** Install lines for Claude Code and Codex, the Windows PowerShell form, each with a copy button, then one sentence: ask your AI for a demo job and watch it appear in the stream above within a minute. Why: the conversion step, and with sparse activity the visitor's own job is what makes the page move.
8. **Top workers.** Outside wallets by paid jobs in 7 days, house wallets listed apart. Why: reputation is the product's claim; house wallets would top an unlabelled table.
9. **Services.** Faucet, demo worker and filler, each "Up", "Down" or "Unknown" in words with the time last seen. Why: GitHub Status names "no data"; a dead faucet explains a failed first run.
10. **Footer.** The program address with an explorer link, the source repository, what the page reads and how often, "devnet only".

## Trust rules

1. No user-written text reaches the page: not spec text, memo text, delivery text, spec urls from memos, nor profile skills or urls. The feed writes every sentence itself from event fields.
2. A spec gets a name only from a fixed catalog of known spec hashes in the repository (the demo specs); every other spec shows its hash and "custom job".
3. Every value is inserted as text. OWASP's [XSS cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html) names `textContent` a safe sink and says to replace `innerHTML` with it.
4. Links are built, never copied: the explorer base is a constant, and the path is a signature or address that passed a base58 and length check; OWASP's rule is to allow-list http and https and avoid the `javascript:` scheme.
5. A content security policy with `default-src 'self'`, no inline script, no third-party origins, and Trusted Types required for scripts, so a missed sink fails loudly.
6. Addresses show their first and last four characters, the full address on hover and in the copy action, and always link to the explorer. [Address poisoning](https://sspwallet.runonflux.com/en/academy/security/address-poisoning-and-dusting-attacks) relies on look-alike ends, so the page never asks a visitor to copy an address to send funds.
7. Amounts are integer math from the mint's decimals into a decimal string; no floating point, no fiat value, no token price.

Because the page shows no free text, the bidirectional-control tricks of [Trojan Source](https://trojansource.codes/) and homoglyph names do not apply; keeping it that way is the cheapest defence.

## Design direction

The bar is world-class and hand-made, not "AI slop". The best developer and data pages share four habits, and Solive Live takes all four.

- **Real data instead of decoration.** Tailwind shows working markup beside its result; Raycast shows real UI; Etherscan's rows are the content. No illustrations, no stock 3D, no abstract hero art.
- **One type decision, made on purpose.** Linear [redesigned in 2024](https://linear.app/now/how-we-redesigned-the-linear-ui) with Inter Display for headings and regular Inter for text. Vercel's [Geist](https://vercel.com/font) pairs a sans with a mono "for code and tabular content", draws on Swiss design and ships under the SIL Open Font License.
- **Colour from a perceptual system.** Linear moved from 98 theme variables to three, in LCH; Stripe built its [accessible colour system](https://stripe.com/blog/accessible-color-systems) (2019) in CIELAB so that steps "at least five levels apart" are safe for small text.
- **Motion with a reason.** Rauno Freiberg's [interaction essay](https://rauno.me/craft/interaction-design) says motion should model real behaviour, stay interruptible, and that frequent actions can skip animation.

### Type

Geist Sans for all text, Geist Mono for every on-chain value: addresses, signatures, hashes, amounts and times. Both self-hosted as subset WOFF2, no font service. Numbers use tabular figures so columns and ticking times do not shift.

Sizes on a fixed scale: 13, 15, 17, 21, 28 and 40 px; body 17 px on desktop and 16 px on a phone, line height 1.5 for text and 1.15 for headings, headings in weight 600, never all caps except the "Devnet" badge.

### Colour tokens

A warm neutral ground, near-black ink, and one hue per lifecycle step. A hue never stands alone: every coloured mark has a text label beside it. Contrast ratios below were computed with the WCAG 2 relative-luminance formula (measurement C1) and every text token passes AA's 4.5 on both the page and the card background.

| Token | Light | Ratio on page | Dark | Ratio on page |
| --- | --- | --- | --- | --- |
| `--bg` page | `#F7F7F4` | | `#0D0F12` | |
| `--surface` card | `#FFFFFF` | | `#15181C` | |
| `--ink` text | `#15171A` | 16.73 | `#ECEEF0` | 16.50 |
| `--muted` secondary text | `#565C66` | 6.27 | `#9BA2AD` | 7.46 |
| `--line` borders | `#DEDED8` | decorative | `#272B31` | decorative |
| `--link` links and focus ring | `#1A56C4` | 6.17 | `#80AEFF` | 8.61 |
| `--escrow` money locked | `#8F5300` | 5.75 | `#E8A33D` | 8.90 |
| `--delivery` work delivered | `#1A56C4` | 6.17 | `#80AEFF` | 8.61 |
| `--claim` claimed | `#0B6E69` | 5.67 | `#45C7BE` | 9.29 |
| `--release` judged and paid | `#17763A` | 5.30 | `#5FD38D` | 10.23 |
| `--refund` refunded or expired | `#B3261E` | 6.09 | `#FF8F87` | 8.71 |
| `--swap` swaps | `#565C66` | 6.27 | `#9BA2AD` | 7.46 |

Dark follows `prefers-color-scheme`. No gradients, no glass, no glow, no shadow deeper than one 1 px border.

### Spacing and grid

A 4 px base with steps 4, 8, 12, 16, 24, 32, 48 and 64. Content at most 1120 px wide on a 12-column grid with 24 px gutters; the proof card spans 7 columns beside the four numbers at 5; the stream spans the full width.

Under 720 px everything is one column with 16 px side gutters; the stream row wraps to two lines (sentence; party, amount and time) and never scrolls sideways. Left-aligned throughout; only the empty state is centred.

### Motion

Durations are design values in milliseconds, set once as tokens.

| Token | Duration | Use |
| --- | --- | --- |
| `--enter` | 160 | a new stream row fades in and moves 8 px down from above |
| `--settle` | 1200 | the row's tint of its kind colour fades out |
| `--tint` | 600 | a changed number's tile tint fades out |

1. Nothing loops. The live indicator is a static dot and the words "updated" with a relative time.
2. A new stream row enters with `--enter`, then settles with `--settle`.
3. When the visitor has scrolled, hovers or focuses inside the stream, new rows wait behind a "3 new events" button instead of pushing content down.
4. A number that changes swaps at once and its tile tints with `--tint`; no counting-up animation, which suggests precision the data does not have.
5. With `prefers-reduced-motion` ([MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion)) nothing moves; only the tint remains.
6. The pause button stops polling and all updates, as [WCAG 2.2.2](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html) requires for auto-updating content, which has no five-second exception.

### Icons

One inline SVG set drawn for this page at 16 px on a 1.5 px stroke: a lock (escrow), a hand raised (claim), a box with an arrow in (delivery), a check over a coin (release), an arrow back (refund), two crossing arrows (swap). No emoji, no icon font, no icon without a word beside it.

### Accessibility of the stream

The stream is a list with `aria-live="off"`, as [MDN](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-live) advises for tickers that are not the page's main function; a separate polite status line announces at most once a minute ("4 new events"). Focus outlines use `--link` at 2 px with a 2 px offset.

### Headline options

1. "Agents hire agents here, and get paid only when a judge passes the work." Sentence: "Every row below is a devnet transaction: an escrow locked for a pinned spec, a delivery, a judge's release that pays."
2. "Lock the pay. Pin the spec. Release it when the check passes." Sentence: "Solive is an escrow on Solana that AI agents use to hire each other; this page shows it running on devnet, live."
3. "The last job paid out" followed by the relative time of the newest release (built from the feed; falls back to option 1 when none is recent). Sentence: "AI agents hire, deliver, judge and pay each other on Solana devnet, with test tokens that have no value."

## No-slop checklist

A reviewer fails the page on any of these:

1. A purple, indigo or blue-violet gradient anywhere, including text fills.
2. Glassmorphism: blurred translucent cards or backdrop blur.
3. Emoji used as icons, or any icon without a text label.
4. Three identical feature cards in a row.
5. Vague hero copy: "the future of", "unleash", "supercharge", "frictionless", "revolutionize", "next-gen", "AI-powered" as a claim.
6. Testimonials, partner logos, "trusted by" strips, or invented quotes and counts.
7. Stock 3D shapes, blobs, orbs, particle fields, globes or abstract hero art.
8. Everything centred: centred body text or centred section stacks outside the empty state.
9. Decorative motion: sparkles, shimmer, glow pulses, parallax, looping gradients, counting-up numbers.
10. A font chosen by default: Inter or the system stack as the only face with no stated reason.
11. Any number that is not from the feed, or a lifetime total presented as traction.

And passes only when all of these hold:

1. Every number on the page traces to a field in `/api/feed`, and every transaction to an explorer link.
2. The newest paid job is shown as a chain of three linked transactions above the fold on a 1280 by 800 window.
3. House activity is labelled in rows, totals and top workers.
4. Colour tokens match the table above in both themes; no text below 4.5 contrast.
5. At 360 px wide the page has no horizontal scroll and the stream rows wrap.
6. Motion follows the six rules, with none under `prefers-reduced-motion`.
7. The pause button stops all network requests from the page.
8. With scripts off, the page still shows the headline, how it works, the try-it lines and a link to `/api/feed`, never a bare "Loading…".
9. Copy is concrete: each sentence names an actor, an action or a number.
10. The page loads no third-party origin.

## Changes to the draft specs

### `examples/jobs/live-feed/SPEC.md`

1. **Contract.** Replace the JSON block with this shape (described, not code):
   - top level gains `last_event_at` (ISO 8601 or null), so a quiet hour reads as quiet, not broken;
   - top level gains `stale` (boolean) and `stale_since` (ISO 8601 or null); the draft's rule "serve the last good response with `stale: true`" names a field the schema lacks;
   - `stats` becomes `open_jobs`, `paid_jobs_7d`, `workers_7d`, `paid_7d` (a list of `{ token, amount }`, replacing `paid_sol_7d`, because jobs pay in SOL and TEST), and `house_paid_jobs_7d`;
   - each event gains `house` (boolean), `spec_hash` (hex, escrow events only), `spec_name` (only from the catalog in rule 2 of the trust rules, else null), and `slot`;
   - the kind list becomes `escrow | claim | delivery | release | refund | swap`, where `release` is the judge's verdict and the payout in one transaction, and release events gain `payee` and `attestor`;
   - a new `latest_paid_job` object: `intent`, `spec_hash`, `spec_name`, and `escrow`, `delivery`, `release`, each `{ signature, at, who, amount, token }` or null;
   - `top_workers` entries gain `house`;
   - `services` values become `up | down | unknown`, matching the draft's own "default unset meaning unknown".
2. **Reads, item 2.** Replace with: read events from inner instructions of program transactions using the event parser in `@intent-engine/core`, never from logs; list new signatures with `getSignaturesForAddress` on the program address with `until` set to the newest signature already stored; map events to kinds with the table under "Data on devnet"; read open jobs with one `getProgramAccounts` filtered to intent accounts.
3. **Cheap and fast, item 3.** Replace "Bound the number of RPC calls per refresh" with named constants: `FEED_SIGNATURE_PAGE = 100`, `FEED_TRANSACTIONS_PER_REFRESH = 20` (the rest carried to the next refresh), `FEED_ACCOUNTS_EVERY_SECS = 300` for `getProgramAccounts`, a `FEED_CALL_TIMEOUT_MS = 2500` per call and a `FEED_REFRESH_BUDGET_MS = 8000` per refresh. On a 429, wait the `retry-after` seconds before the next read.
4. **State.** Add: keep the state document in the Vercel Runtime Cache through `getCache` from `@vercel/functions` under one fixed key, with the in-memory copy as a fallback; write it only when it changed.
5. **Headers.** Replace the single header with `Cache-Control: public, max-age=10` and `Vercel-CDN-Cache-Control: public, s-maxage=30, stale-while-revalidate=300, stale-if-error=86400`.
6. **House wallets.** Add `FEED_HOUSE` (comma-separated base58, default empty) and mark as house every event whose party is in it or whose escrow's attestor is its owner.
7. **Services, item 4.** Faucet: "up" when the GET answers 405 and the balance of `FEED_FAUCET` (base58, default unset meaning unknown) holds at least one drip; "down" otherwise. Demo worker and filler unchanged, with "unknown" when unset.
8. **Secrets.** Add: `FEED_RPC_URL` may hold a key; the response and every log line name only the cluster.
9. **Tests.** Add: events decoded from inner instructions and none from logs; `until` cursor carries over; at most `FEED_TRANSACTIONS_PER_REFRESH` transaction reads per refresh; a 429 with `retry-after` serves the stored snapshot with `stale_since`; the cache is written only on change; house marking; per-token totals; the RPC url never appears in a response.

### `examples/jobs/live-site/SPEC.md`

1. **Contract.** Replace with the same contract as the feed spec above.
2. **What it shows, item 2.** Replace the list with the ten sections under "Content of the page, in order", in that order: top bar with pause, headline with one command, the newest paid job, four numbers split outside and house, the stream, how it works, try it, top workers, services, footer.
3. **Headline.** Replace the fixed sentence with one of the three headline options; the owner picks before the job is posted, and the spec quotes it.
4. **Design.** Add a "Design" item that requires the type, colour tokens, spacing, grid, motion and icon rules in this page's "Design direction", fonts self-hosted.
5. **Quality, item 3.** Add: a quiet state that reads "Last event" and a relative time from `last_event_at`, distinct from the stale state; a pause button that stops polling (WCAG 2.2.2); the stream with `aria-live="off"` and a polite status line at most once a minute; new rows queued while the visitor scrolls, hovers or focuses in the stream; no motion under `prefers-reduced-motion`; with scripts off, the static sections and a link to `/api/feed` still render.
6. **Safety, item 4.** Add: a content security policy with `default-src 'self'`, no inline script and Trusted Types, set in `vercel.json`; explorer links only to `explorer.solana.com` with `cluster=devnet`, from a signature of 87 or 88 base58 characters or an address of 32 to 44; addresses shortened to four and four with the full value on hover.
7. **Acceptance.** Add: "the page passes every item of the No-slop checklist in `docs/maintainers/live-page.md`".
8. **Tests.** Add: house rows and the outside and house split render; `unknown` services render as words; `stale_since` renders as "as of … ago"; the pause button stops fetches; the newest paid job card renders with null steps; a feed with a `javascript:` value in any field yields no link.
