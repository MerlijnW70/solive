# Job: name a job mint's freeze authority to workers

Threat T-83: an owner escrows a mint whose freeze authority it controls, takes the delivered work, then freezes the vault or the worker's token account, so the worker is never paid. The program cannot refuse such mints, because stablecoins such as USDC carry a freeze authority. Workers must see it before they take a job.

## Build

- The client reads a mint's freeze authority: the SPL mint layout holds a 4-byte option tag at offset 46 and the authority at offset 50, the same for Token and Token-2022. Return it as an address or `null` beside the decimals the client already reads (`packages/client/src/accounts.ts`).
- Each job in `solive_find_jobs` and `intent-engine jobs` gains `freeze_authority`: the freeze authority of its `input_mint`, or `null` when the mint has none or could not be read.
- `solive_get_spec` gains the same `freeze_authority` for the escrow it reads.
- When `freeze_authority` is not `null`, the tool and command name it in one plain sentence: whoever holds it can freeze the payment, and it is the owner itself when it equals the escrow's owner.
- Update T-83 in `docs/maintainers/threat-model.md`: replace the plan with the evidence (the tests that show it) and drop it from the open list, keeping the gap that the program does not read the authority.

## Rules

- Read each mint once per call, not once per job.
- Tool descriptions stay short: add at most one sentence.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed.
- Regenerate `docs/reference`. Change only `packages/client`, `packages/cli` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests cover a mint without a freeze authority, one whose authority is a third party, one whose authority is the escrow owner, a Token-2022 mint, and the same values in the command and both tools.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
