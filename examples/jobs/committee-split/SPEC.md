# Job: Committee-judged split releases can be sent (E1)

The deep audit (A3-02, A1 M8, A3-14) found that the program instruction `fill_attested_split_committee` and its core builder exist, but no client, CLI or MCP path can send it: the client refuses a committee-judged split outright, so above the committee floor multi-worker payouts are impossible. `docs/judge.md` describes such releases. A split whose judge is also a recipient is also refused by the client although the program accepts it.

## Build

1. **Client.** `settleSplit` (`packages/client/src/client-split.ts`) settles a committee-judged split from member votes, using the existing core builder, with the same preview and checks as a single-judge split. Members' votes for a split are produced and verified as for committee releases today.
2. **CLI and MCP.** The committee vote and release tools and commands can vote on and release a split, previewed and approved like the existing committee release, including Ledger members one transaction at a time.
3. **Judge as recipient.** A split whose judge is also among the recipients builds a valid cosign instead of failing on a duplicate signer, in single and committee splits.
4. **Docs.** `docs/judge.md` describes what is now possible, truthfully.

## Tests

Each item has a test that fails without its fix, on LiteSVM against the real program: a committee-judged split release pays every recipient its weight; a split with the judge among the recipients settles; the CLI and MCP preview of a committee split shows the shares.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only `packages/client/src/client-split.ts`, `client-settle.ts` and committee helpers, `packages/cli/src/agent/wallet/split.ts`, `agent/wallet/committee.ts`, `committee-commands.ts`, `docs/judge.md`, their tests and generated references. No program change.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
