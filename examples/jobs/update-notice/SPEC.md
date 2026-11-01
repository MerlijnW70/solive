# Job: Tell users when a newer Solive is out

Users start the MCP server and the CLI with `npx -y @intent-engine/cli …`. npx can keep running a version it already has in its cache, so a user stays on an old release without knowing it, and misses fixes such as the clearer start for an empty wallet.

## Build

1. **Check once, cheaply.** When the MCP wallet server starts, and when `setup` runs, look up the newest published version of `@intent-engine/cli` on the npm registry with one request and a short timeout. Cache the answer on disk next to the CLI settings for about a day, so it does not ask on every start. A failed or slow lookup is silent and never delays or breaks anything.
2. **Say it once.** When a newer version exists, `solive_wallet_setup` and `solive_wallet_balance` add an optional `update` field: the newer version and the one command that gets it (`npx -y @intent-engine/cli@latest version`, then restart the app). The CLI `setup` output adds the same. Additions only; nothing else changes.
3. **Opt out.** An environment variable turns the check off; document it in `docs/mcp.md` and the CLI help, in the repository's terse style.
4. **Privacy.** The lookup sends nothing but the package name: no wallet address, no key, no usage data.

## Tests

Each fails if its behaviour breaks: a newer version yields the `update` field with the right command; the same or an older version yields none; a cached answer younger than a day is reused without a request; a failed, slow or malformed registry answer yields no field and no delay beyond the timeout; the opt-out variable stops the request; the request carries nothing but the package name.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines. Keep tool texts within `packages/cli/test/plain-words.test.ts`; do not raise its limits.
- Additions only to tool outputs and CLI output. No new dependency.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
