# Job: The MCP server's instructions and outputs are true for every served set (E3)

The deep audit (A2 A1, A2, A4, A6, A7, A14) and later reviews found MCP texts and outputs that are untrue in some server modes.

## Build

1. **Signing promise.** The served instructions say signing tools only preview, but with `--wallet --agent` or `--wallet --relayer` the server also serves `agent_create` and `submit_signed_intent`, which send on the first call (`packages/cli/src/agent/mcp.ts`, `everyday.ts`, `mandate-agent.ts`, `signed-submit.ts`). Make the instructions true for every served set: either give those tools the preview and approval flow, or scope the promise to the tools it covers and say which tools send at once.
2. **Amount units.** The instructions say amounts are whole tokens, but tools served beside the wallet take raw units (`schema.ts`, `shapes.ts`). Say which tools take raw units, in the instructions served when they are present.
3. **Only served tools are named.** Mandate tools name tools that are not served in wallet and agent mode (`mandate-revoke.ts`, `mandate-grant.ts`), and summaries are not filtered. Name only served tools, everywhere text reaches the agent.
4. **Complete contact list.** The wallet notice's "Contacts only" list (`agent/wallet/guard.ts`) misses work urls and the spec mirror.
5. **Reputation does not fail on many mints.** `get_reputation` fails with `Failed` when a worker has more than 32 counted mints, which third parties can cause by naming the wallet as a co-author (`agent/reputation.ts`). Sort and truncate to the schema's cap with a count of the rest.
6. **Held shares tell the truth.** `wallet_claim_held` and CLI `claim-held` say nothing is held whenever no share is listed, even when the read was incomplete; the MCP summary keeps only some reasons and drops the past-limit one (`agent/wallet/held.ts`, `announce-commands.ts`). Say the list is incomplete and why, keeping the important reason, and let callers widen the client's bounds.
7. **Deliver descriptions.** `wallet_deliver` and `prepare_deliver` descriptions say no tokens move, while an announce fee may move SOL (`agent/wallet/delivery.ts`). Make them match the previews.
8. **Tests check what is served.** Instruction tests check constants the server no longer sends (`WALLET_INSTRUCTIONS`, `MARKET_GUIDE`); test `instructionsFor(...)` for each served set instead, and remove exports used only by tests from `agent/untrusted-fields.ts` or move them into tests.

## Tests

Each item has a test that fails without its fix: with `--wallet --agent`, the served instructions neither say every signing tool previews nor that every amount is whole tokens; no served text names an unserved tool; a worker with 33 earned mints gets a reply with a rest count; an incomplete held-share read says so; the deliver description and preview agree.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines; tool descriptions stay within the word limit the tests set.
- Only `packages/cli/src/agent/mcp.ts`, `everyday.ts`, `mandate-*.ts`, `signed-submit.ts` (texts and flow only), `schema.ts`, `shapes.ts`, `reputation.ts`, `untrusted-fields.ts`, `agent/wallet/guard.ts` (notice only), `agent/wallet/held.ts`, `agent/wallet/delivery.ts` (descriptions only), `announce-commands.ts`, their tests and generated references. No program change.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
