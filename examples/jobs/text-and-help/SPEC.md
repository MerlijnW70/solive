# Job: Refusal texts, error codes and bounds say what the code does (F3)

The deep audit (A2 C15, W5, A9, A10, M5, M6, A3-08) and the review of E3 found texts and error codes that do not fit their cases.

## Build

1. **Cluster names.** `RATE_LIMITED_HINT` (`rpc-failure.ts`, used for any 429 in `main.ts`) and `airdropRefused` / `heldRefused` (`wallet.ts`) name devnet whatever `--url` is. Name the cluster actually used, or say nothing about it.
2. **History fees.** `wallet_history`'s profit `fees` (`agent/wallet/history-profit.ts`) claims to include judge fees, but sums only `fee + partnerFee`. The judge fee is paid separately by `pay_judge`. Add the judge fee when the judge is not this wallet, or describe the field truthfully. `difference` must match the description.
3. **Error codes.**
   - `ReleaseChanged` is reused for non-release approvals (`agent/work-claims.ts`, `agent/profile.ts`, `agent/reputation.ts`), while its catalog row in `agent/problems.ts` describes a release only. Give those refusals a fitting code, or widen the row.
   - `KeyInUse` now covers four cases (Ledger encryption key, agent key is the wallet, relayer key is the wallet, server key at the wallet path), but its catalog row describes only the first. Give each case a fitting code, or widen the row so all four are named.
   - `FeeAccountNotCanonical`'s text does not fit the announce path.
4. **Unreadable wallet key.** When the wallet's key file cannot be read at call time, `agent_create` and `submit_signed_intent` skip the key-equals-wallet checks (`agent/mandate-agent.ts`, `agent/signed-submit.ts`, `.catch(() => undefined)`). Refuse the call instead.
5. **Mandate bounds.**
   - The CLI `--max-intents` accepts 0 up to the u32 maximum (`order-builders.ts`), while the MCP schema accepts 1 to `MAX_MANDATE_INTENTS` (`agent/mandate-grant.ts`). Make both accept the same range and test the edges.
   - `MAX_MANDATE_SECONDS` (`agent/mandate-state.ts`) duplicates `MAX_EXPIRES_IN` (`agent/create.ts`), and `mandate-state.ts` redefines the i64 bounds. Use one constant for each.
6. **Multisig texts.**
   - The printed "sha256" (`packages/multisig/src/program-metadata.ts`) is the hash of the hex text, not of the bytes. Hash the bytes, or label it truthfully.
   - An undecodable config transaction is described as a batch (`packages/multisig/src/review.ts`). Describe it as undecodable, and keep the refusal.

## Tests

Each item has a test that fails without its fix:
- A 429 on a non-devnet url names no devnet.
- `fees` and `difference` include a judge fee paid to another judge.
- Each code changed in item 3 is pinned by a test of its refusal.
- An unreadable wallet key file refuses `agent_create`, and nothing is sent.
- `mandate grant --max-intents 0` is a usage error, as the MCP schema is.
- The printed sha256 equals `sha256` of the bytes.
- An undecodable config transaction is not called a batch.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only these files under `packages/cli/src/`:
  - `rpc-failure.ts`
  - `main.ts` (the 429 hint only)
  - `wallet.ts`
  - `order-builders.ts`
  - `agent/problems.ts`
  - `agent/wallet/history-profit.ts`
  - `agent/work-claims.ts`, `agent/profile.ts`, `agent/reputation.ts` (codes only)
  - `agent/mandate-agent.ts`, `agent/signed-submit.ts`, `agent/wallet/account.ts` (codes and the unreadable-key refusal only)
  - `agent/mandate-grant.ts`, `agent/mandate-state.ts`, `agent/create.ts` (constants only)
- Also `packages/multisig/src/program-metadata.ts` and `packages/multisig/src/review.ts`, plus their tests and the generated references.
- Another job edits the fetch rows of `problems.ts`; rebase on main before delivering. No program change.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
