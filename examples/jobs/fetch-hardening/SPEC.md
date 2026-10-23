# Job: Fetch only what was checked, and say why it failed

A review of how Solive fetches specs and work at 0.1.49 found these gaps. Each has a failing test in the review.

1. The private-address check resolves a host once, then the fetch resolves it again; nothing ties the connection to the checked addresses. A host that answers a public address to the check and a loopback or metadata address to the fetch makes the judge's machine request that address. This affects `wallet_fetch_work`, `solive_get_spec`, the escrow spec check and the judge's delivery fetch.
2. Some special IPv6 ranges count as public: IPv4-compatible `::7f00:1`, IPv4-translated `::ffff:0:7f00:1`, site-local `fec0::/10`.
3. `solive_get_spec` reports a body that breaks off mid-stream as a permanent failure, and a redirecting spec url as retryable, though `SpecUnfetchable` says redirects are permanent.
4. `solive_get_spec` returns `matches: true` with text decoded leniently: invalid UTF-8 becomes U+FFFD and a leading byte order mark is dropped, so the text is not the bytes it hashed. `wallet_fetch_work` drops a leading byte order mark too.
5. The escrow spec check reads up to `MAX_ARTIFACT_BYTES`, while `solive_get_spec` reads up to `MAX_SPEC_BYTES`, so an escrow whose spec no worker can read previews clean; it also fetches `spec_url` before checking it against the memo url rule.
6. The escrow spec check does not warn when a sealed spec is not sealed to the escrow's attestor, or to every member of a committee attestor, so the judge cannot read it.
7. `wallet_escrow` and `wallet_escrow_plan` let an invite-only escrow open claims without saying that a wallet outside the invite list can hold a claim and block payment until it lapses.

## Required

- Every fetch of a spec or of delivered work connects only to addresses that passed the private-address check, resolved once per fetch.
- The private-address check refuses the IPv6 ranges in item 2, and 6to4 and Teredo addresses that embed a private IPv4 address.
- `solive_get_spec` reports a body that breaks off or times out as retryable, and a redirect as `SpecUnfetchable`, with the cause in the hint.
- `solive_get_spec` returns text only when the bytes are valid UTF-8, keeping a byte order mark, and says when it leaves the text out; `wallet_fetch_work` keeps a byte order mark.
- The escrow and plan spec check reads no more than `solive_get_spec` does and warns when the spec is larger, and checks `spec_url` against the memo url rule before fetching it.
- The escrow and plan spec check warns when a sealed spec does not cover the attestor or every committee member.
- `wallet_escrow` and `wallet_escrow_plan` warn when they open claims on an escrow whose spec is sealed, saying an uninvited wallet can hold a claim until it lapses and to keep `claim_secs` short.
- Tests for each change; every changed text follows the repository's tool text rules and the served-tool check.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Only `packages/cli` and `packages/client`, plus the generated references and docs the tests check. No program change. Do not change the invite check, the release and committee tools, `wallet_claim`, `wallet_deliver`, `packages/core/src/sealed.ts` or the seal tools.
- Keep tool names and existing inputs as they are. Use only local servers and stubbed lookups in tests. Keep files under about 500 lines.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names, and the docs site still builds.
2. A test serves a name that resolves to a public address for the check and to loopback afterwards, and shows no connection reaches the loopback server; it fails when the judge restores the second lookup.
3. Tests show each item 2 address refused, the body cut and redirect cases in item 3, and the lossy text case in item 4.
4. A test shows the escrow preview warning for a spec over the `solive_get_spec` limit and for a sealed spec not sealed to the attestor.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
