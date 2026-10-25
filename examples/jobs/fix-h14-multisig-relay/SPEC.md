# Job: The multisig review flags any program that is handed the vault's signature

Audit round H14 (finding PX-4, packages/multisig/test/hunt/px-relayed-authority.test.ts) showed that a vault proposal whose one instruction calls a generic relay program, passing the upgradeable loader, the engine's program data and the vault as signer with loader `SetAuthority` data, is shown by `show` as "Runs program X with N accounts…, signed by <vault>" with no problem. `approve --yes` signs it and `execute` hands the engine's upgrade authority to whoever the proposer chose. The review in packages/multisig/src/review.ts decodes only instructions sent directly to the engine or the loader; the vault's signature carries through a cross-program call, so any other program that receives it can do anything the vault can.

## Required

1. An instruction of a vault proposal that passes the vault as a signer to a program the review does not fully decode is a problem: the review names the program, says that it receives the vault's signature and can therefore change program code, the upgrade authority or move vault funds through calls the tool cannot show, and `approve` and `execute` refuse it unless the member passes a new explicit flag whose name says what it allows. The flag works on every cluster, and the refusal holds on every cluster, since a borrowed vault signature is as dangerous on devnet.
2. Programs the review fully decodes keep their current descriptions: the engine, the upgradeable loader, and any program this job adds a full decoder for (at least the system program's transfer, so a plain SOL payment from the vault is described with its amount and recipient rather than refused). An instruction that does not pass the vault as a signer is described as before.
3. The hunt test packages/multisig/test/hunt/px-relayed-authority.test.ts is added unchanged from its delivery (it is in the H14 kit) and passes with the patch, as do the existing multisig tests.
4. docs/maintainers/operations.md and the threat model's T-64 row describe the refusal and the flag; the generated CLI references are regenerated if they change.
5. Tests for each change, including a relayed transfer of vault funds and a direct system transfer from the vault.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Change only packages/multisig, its docs, the threat model row and generated references. Keep TypeScript files under about 500 lines.

## Acceptance

1. With the patch applied to `main` at the commit the delivery names: `cargo test --workspace`, `bash scripts/ts-test.sh`, `bash scripts/lint.sh` and `bash scripts/pack-test.sh` all pass.
2. The hunt test passes.
3. A test fails when the judge makes the review describe an unknown program that receives the vault's signature without a problem again.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
