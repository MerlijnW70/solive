# Operations

Who holds the engine's power, and the exact steps to move it to a multisig. The [threat model](threat-model.md) lists this as T-52.

## Roles

| Role | Can | Target holder |
| --- | --- | --- |
| upgrade authority | replace the program | the vault of a 2-of-3 Squads v4 multisig |
| config admin | set fees, kinds, the guardian and the fee recipient; raise and lower pauses; hand over the admin role | the same vault |
| guardian | raise pause flags, nothing else | a separate key, outside the multisig |

The guardian acts alone and at once, because a pause has to be fast; a stolen guardian key can only pause, and the admin lowers the pause. Every other change waits for two of the three members.

The create pause stops new intents. The fill pause stops fills and judge releases, and with them `claims take` and `claims standby`, so no worker locks a new stake; a kind whose fills the admin stopped refuses the same. Nothing that returns funds waits for a pause: cancel, expire, `claims drop`, `claims leave`, `claims advance`, `claims settle`, `migrate` and `close-legacy` still work.

Devnet today:

| Devnet role | Holder |
| --- | --- |
| multisig | `D2DffpdbegJMjTvsvtcQa61D1m5HLQvp5mFwUmeaHC6d` |
| upgrade authority and config admin, the multisig's vault | `DxF6mApa3rnN7QgdqjtBvgyDesvKhVTYQ14Giike4Urv` |
| guardian | `EPPDJ5WaQs3GSvTwt1N5BmPtX9A7W2H5sXYk9Y2Z9ahP` |

## Tools

Run every command from a checkout of this repository, on Linux, macOS or WSL, with the Solana CLI installed:

```sh
pnpm install --frozen-lockfile
pnpm --filter @intent-engine/core build
pnpm --filter @intent-engine/client build
pnpm --filter @intent-engine/solver build
pnpm --filter @intent-engine/cli build
pnpm --filter @intent-engine/multisig build
```

`node packages/multisig/dist/bin.js` drives the multisig: `create`, `propose-upgrade`, `propose-authority`, `propose-admin`, `propose-time-lock`, `approve`, `execute`, `reject` and `show`. It talks to Squads v4 at `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`. Every command that sends prints a preview and a simulation and sends only with `--yes`. Every command prints JSON and refuses with a JSON error, for example when the signer is not a member or a proposal has too few approvals. `--url` prints only the scheme, host and port of the RPC url, so an API key in its path or query stays out of the output. `node packages/cli/dist/src/bin.js` is the engine CLI; with `--authority <address>` an admin command prints its instructions unsigned instead of sending them, and `propose-admin` wraps exactly those instructions in a proposal.

## 1. Make the keys

Three member keys and one guardian key. On devnet they are demo files; before mainnet see [Real keys](#real-keys).

```sh
solana-keygen new --no-bip39-passphrase --outfile member-a.json
solana-keygen new --no-bip39-passphrase --outfile member-b.json
solana-keygen new --no-bip39-passphrase --outfile member-c.json
solana-keygen new --no-bip39-passphrase --outfile guardian.json
solana airdrop 1 member-a.json --url devnet
solana airdrop 1 member-b.json --url devnet
solana airdrop 1 member-c.json --url devnet
```

`solana-keygen pubkey member-a.json` prints a key's address. Below, `<a>`, `<b>`, `<c>` and `<guardian>` stand for those addresses and `admin.json` for the key that holds the three roles today.

## 2. Create a 2-of-3 multisig

```sh
node packages/multisig/dist/bin.js create --members <a>,<b>,<c> --threshold 2 --keypair member-a.json --url devnet
node packages/multisig/dist/bin.js create --members <a>,<b>,<c> --threshold 2 --keypair member-a.json --url devnet --yes
```

The output names `multisig` and `vault`; below they are `<multisig>` and `<vault>`. The vault signs for the multisig and pays the rent of what it creates, so fund it:

```sh
solana transfer <vault> 0.1 --allow-unfunded-recipient --keypair member-a.json --url devnet
```

`--time-lock <seconds>` on `create` makes every approved proposal wait that long before it executes.

`propose-time-lock --multisig <multisig> --seconds <n> --keypair member-a.json` proposes a config transaction that changes the time lock later, with `n` from 0 to `MAX_TIME_LOCK`; members approve and execute it with `--allow-config`. Once it executes, the new time lock also delays this change's own successors, including the next time lock change.

## 3. Move the upgrade authority

```sh
solana program set-upgrade-authority GHFB9q4fhhqRyCoycoivdxMhFkp1aLHJk5VvroUsgrJU --upgrade-authority admin.json --new-upgrade-authority <vault> --skip-new-upgrade-authority-signer-check --keypair admin.json --url devnet
solana program show GHFB9q4fhhqRyCoycoivdxMhFkp1aLHJk5VvroUsgrJU --url devnet
```

`show` prints `Authority: <vault>`. Check the vault address twice before this step: a wrong address loses the program for good.

## 4. Move the config admin

The current admin proposes the vault, then the multisig accepts:

```sh
node packages/cli/dist/src/bin.js propose-admin --keypair admin.json --new-admin <vault> --url devnet --yes
node packages/multisig/dist/bin.js propose-admin --multisig <multisig> --keypair member-a.json --url devnet --yes -- node packages/cli/dist/src/bin.js accept-admin --authority <vault> --url devnet
```

The second command prints the proposal's `index`, here `<n>`. Two members approve and one executes:

```sh
node packages/multisig/dist/bin.js show --multisig <multisig> --index <n> --url devnet
node packages/multisig/dist/bin.js approve --multisig <multisig> --index <n> --keypair member-a.json --url devnet --yes
node packages/multisig/dist/bin.js approve --multisig <multisig> --index <n> --keypair member-b.json --url devnet --yes
node packages/multisig/dist/bin.js execute --multisig <multisig> --index <n> --keypair member-b.json --url devnet --yes
node packages/cli/dist/src/bin.js show config --url devnet
```

`show` decodes the proposal before anyone approves it: `Intent engine AcceptAdmin {}, signed by <vault>`. `approve` and `execute` print the same decoded summary, every instruction with its program and every account with its signer and writable flags. `show config` then names the vault as admin.

## 5. Set a separate guardian

```sh
node packages/multisig/dist/bin.js propose-admin --multisig <multisig> --keypair member-a.json --url devnet --yes -- node packages/cli/dist/src/bin.js update-config --authority <vault> --guardian <guardian> --url devnet
```

Approve it with two members and execute it as in step 4. `show config` then names `<guardian>` as guardian. `admin.json` now holds no role. Every later admin change, such as `set-economics`, `update-config`, `raise-pause`, `lower-pause`, `set-mint-cap`, `set-caps-required` or `set-committee-floor`, goes through `propose-admin` with `--authority <vault>` in the same way.

## Staged caps

Escrow caps bound what one program bug can reach. Each input mint gets a cap account with three limits: the most one intent escrows, the most all new intents together escrow in a window of seconds, and the most all open intents of the mint hold at once. Start the limits small and raise them as the program earns trust.

1. Give every mint the engine trades a cap. Amounts are raw units of the mint; the program refuses a window shorter than `MIN_CAP_WINDOW_SECS` in `programs/intent_engine/src/state.rs`. `--total-limit` sets the outstanding limit; zero means none, and leaving it out keeps the current one, or none for a new cap:

   ```sh
   node packages/multisig/dist/bin.js propose-admin --multisig <multisig> --keypair member-a.json --url devnet --yes -- node packages/cli/dist/src/bin.js set-mint-cap --authority <vault> --mint <mint> --max-per-order <raw> --window-cap <raw> --window-secs 3600 --total-limit <raw> --url devnet
   ```

   The first proposal for a mint creates its cap and the vault pays the rent; later proposals change the limits and keep the current window and the outstanding amount. Approve and execute as in step 4. `show` decodes it as `Intent engine SetMintCap {"maxPerOrder":"<raw>","windowCap":"<raw>","windowSecs":3600,"totalLimit":"<raw>"}, signed by <vault>`.
2. Check each cap, its current window and its outstanding amount:

   ```sh
   node packages/cli/dist/src/bin.js show mint-cap --mint <mint> --url devnet
   ```

3. Require caps. From then on every create passes its input mint's cap, and the engine refuses intents selling a mint without one:

   ```sh
   node packages/multisig/dist/bin.js propose-admin --multisig <multisig> --keypair member-a.json --url devnet --yes -- node packages/cli/dist/src/bin.js set-caps-required on --authority <vault> --url devnet
   ```

Every create names an optional mint cap account; a create without a cap passes the program id in its place. While caps are off, creates ignore the cap even when one is passed. The SDK, the CLI and the MCP tools pass the input mint's cap whenever it exists, so caps can be set before they are required. Clients built from 0.1.26 or earlier stop working on create once this program is deployed, because the create account lists changed. `set-caps-required off` lifts the requirement. Clients built from 0.1.26 or earlier also cannot release proof escrows on a program with job claims, because the release account lists gained the optional claims board and stake account; use 0.1.27 or later. Since the cancel of a claimed escrow passes its claims board, clients built from 0.1.28 or earlier cannot cancel an escrow whose owner opened claims; use 0.1.29 or later.

While caps are required, every create adds what it escrows to its mint cap's outstanding amount, and the engine refuses a create that would take it past the total limit with `MintCapTotal`. Each fill, release, cancel, expire and close subtracts what left the vault, up to what that intent added. Tokens sent to a vault from outside are never counted. The intent records what it still counts, and an exit of an intent that counts anything must pass the mint cap.

Intents created while caps are off are not counted, so the total limit bounds what the program holds only while caps stay on. A funded party can fill a total limit with its own capital until the admin raises or zeroes it, so watch the outstanding amount with `show mint-cap` or the monitor.

Fills, releases, cancels, expiries and closes now name the optional mint cap too, so clients built from 0.1.42 or earlier cannot settle intents on this program; use a later one. The SDK, the CLI and the solver pass the cap whenever the intent counts escrow.

## Upgrade

1. CI builds the program verifiably and prints its hash, `<hash>`, and uploads the build as the `intent-engine-verifiable` artifact.
2. From a clean checkout at `origin/main`, run `bash scripts/deploy.sh devnet <hash> --multisig <multisig>`. The Solana CLI default keypair, or the file in `UPGRADE_AUTHORITY`, pays for the buffer; the file in `MULTISIG_MEMBER`, by default the same key, proposes and has to be a member. It checks the cluster genesis, a clean tree, that HEAD is `origin/main`, that the program is upgraded by the vault and that the build hashes to `<hash>`. It learns the vault from `vault`, as below. It writes the build to a buffer, checks the buffer hash, hands the buffer to the vault and proposes the upgrade. It executes nothing. To reuse the CI build instead of rebuilding locally, place that artifact's `intent_engine.so` in `verifiable/` and set `VERIFY_FROM_ARTIFACT=1`; the hash is recomputed from the bytes and still has to equal `<hash>`.
3. Each approving member reads the proposal first: `show --index <n>` prints `Upgrades program GHFB9q4fhhqRyCoycoivdxMhFkp1aLHJk5VvroUsgrJU to the code in buffer <buffer>, signed by <vault>; the buffer's rent goes to <spill>; the buffer hashes to <hash> and is controlled by <vault>`. `approve` refuses unless the buffer exists and the vault controls it, and prints the hash as `buffer_hash`; it has to equal `<hash>`, the same value `solana-verify get-buffer-hash --url devnet <buffer>` prints. It also simulates the proposal's instructions as the vault and prints `post_state`, the sha256 of the code the program data holds afterwards, without trailing zeros; `buffer_hash` is that hash whenever the simulation succeeds, as in [Simulated post-state](#simulated-post-state).
4. Two members approve and one executes with the hash it approved:

   ```sh
   node packages/multisig/dist/bin.js execute --multisig <multisig> --index <n> --expect-buffer-hash <hash> --keypair member-b.json --url devnet --yes
   ```

   `execute` refuses without `--expect-buffer-hash`, and checks again right before it sends that the vault still controls the buffer and that the buffer still hashes to `<hash>`. It then simulates the exact transaction it sends and refuses unless the program data it sets holds code that hashes to `<hash>`; it prints that hash under `post_state`.
5. `solana-verify get-program-hash --url devnet GHFB9q4fhhqRyCoycoivdxMhFkp1aLHJk5VvroUsgrJU` prints `<hash>`.
6. Replace the program the client package ships, which `createTestWorld` runs, with the deployed one, and write the new baseline, in one commit:

   ```sh
   cp verifiable/intent_engine.so packages/client/program/intent_engine.so
   solana-verify get-executable-hash packages/client/program/intent_engine.so
   node packages/cli/dist/src/bin.js monitor --write-baseline monitoring/devnet.json --url devnet
   ```

   `verifiable/intent_engine.so` is the CI artifact from step 1 and the hash printed has to equal `<hash>`. The baseline's `programHash` becomes `<hash>`; the client tests fail while the shipped file and `programHash` differ, so a release never ships a program other than the deployed one.

A build larger than the program's data account fails at `execute` with `account data too small for instruction`. `solana program show GHFB9q4fhhqRyCoycoivdxMhFkp1aLHJk5VvroUsgrJU --url devnet` prints that size as `Data Length`. Before executing, any key can grow it with `solana program extend GHFB9q4fhhqRyCoycoivdxMhFkp1aLHJk5VvroUsgrJU <bytes> --url devnet`, and pays the rent for the extra bytes.

`node packages/multisig/dist/bin.js vault --multisig <multisig> --url devnet` reads the multisig account once and prints `vault`, `threshold`, `timeLock`, `members` and `transactionIndex` as JSON. It reads no proposals, so a rate-limited public RPC answers it, and it refuses an address that is not a Squads v4 multisig. `deploy.sh` and `idl.sh` read the vault with it; both build `packages/core`, `packages/client` and `packages/multisig` first, since the multisig tool imports the client.

On mainnet-beta, told apart by the genesis hash, `deploy.sh` also refuses:

- to upgrade a program that already exists without `--multisig`; only a first deploy goes without one, and it refuses when `solana program show` fails for any reason other than a missing account;
- a multisig with a threshold below 2;
- a multisig with a time lock of 0; raise it with `propose-time-lock` first.

An `https` url that serves the mainnet-beta genesis counts as mainnet-beta. On every other cluster `deploy.sh` accepts any threshold and time lock and upgrades without `--multisig`, as before.

A loader Close of the engine's program data ends the program for good: it can never run again and every escrow it holds is locked. `show`, `approve` and `execute` decode each Close, name the closed account, the recipient, the authority and the program, and say whether it closes a buffer or a program's data. Closing a buffer the vault holds, after an aborted upgrade, is shown and signed as before.

For a Close of the engine's program data, `show` always prints the warning, and `approve` and `execute` put it first in the summary and in `proposal.warning`. On mainnet-beta, told apart by the genesis hash as `deploy.sh` does, they refuse unless the member passes `--allow-engine-close`. On devnet and every other cluster they print the warning and sign, so the devnet loop stays fast. A Close of another program's data is described but not refused.

## Account versions

Every account the program owns carries a `version` byte, set at creation to the current version of its type in `programs/intent_engine/src/state.rs`. Each type keeps its version byte, and the wallet that paid for it, at fixed offsets listed in `programs/intent_engine/src/versions.rs`, so a later program can read the version of any older account. Every instruction refuses an account whose version is not the current one with `AccountOutdated`.

A change to an account layout raises that type's version. Accounts made before versions were enforced carry version 1, or 0 for stand-by entries, and the program refuses them until `migrate` rewrites them, with one exception: an owner always gets an escrow back.

`cancel_intent`, `expire_intent` and `close_intent` accept intents from `OLDEST_INTENT_VERSION` on. They read the mint cap by hand: a cap from `OLDEST_MINT_CAP_VERSION` on gives the amount back, never below zero. A cap that is gone or of another version is skipped, and so is a cap created after the intent, whose count never held it, so no refund depends on the cap and none lowers a recreated cap's count. Cancelling and `settle_claims` accept claim boards from `OLDEST_CLAIMS_VERSION` on.

Fills and releases give back to the cap by the same rule: against a cap created after the intent they only clear the intent's own count, so an intent charged before its cap was closed and recreated never lowers the new cap's count.

`close_legacy` closes an outdated account. Anyone may send it for a program-owned account whose discriminator matches no account type, whose size differs from its type's, or whose version is not current. It never closes a config or user state, which `migrate` upgrades in place, and refuses them with `LegacyMigrates`.

Its lamports go to the wallet its layout records as the payer: the owner of a mandate or claim board, the rent payer of an intent, the worker of a stand-by entry, or the wallet of a profile. Mint caps, committees and unknown accounts record no payer, and a payer that cannot hold lamports is skipped; theirs go to the config's fee recipient.

`close_legacy` reads the escrow of a claim board or stand-by entry and refuses one whose escrow is still open with `LegacyLineOpen`; `migrate` upgrades it in place, so it keeps its place in the line. Once the escrow is no longer open, a board's held stake goes where `settle_claims` would send it: to the worker of a held claim, or to the owner for a lapsed one.

It refuses a current account with `NotLegacy`, and an intent whose vault is still a token account with `LegacyVaultOpen`: cancel, expire or close that intent instead.

```sh
intent-engine close-legacy --keypair payer.json --address <account> --url devnet
```

Without `--yes` it previews the account, its version and the payee and sends nothing.

## Migrate accounts

Devnet runs the stand-by line program (`220dde3`). The current program keeps every field of that program at the same offset and adds fields only in bytes the stand-by line kept zero, or past its end. `tests/svm/tests/layout_history.rs` pins both layouts. Offsets below count from the start of the account, discriminator included.

| Type | Stand-by line size | Current size | Version byte, old to new | Added since the stand-by line |
|---|---|---|---|---|
| Config | 216 | 536 | 147: 1 to 2 | `floor_mints` at 216, `floor_amounts` at 472; zero is no floor |
| UserState | 152 | 152 | 80: 1 to 2 | nothing |
| Intent | 464 | 464 | 172: 1 to 2 | `fee_bps` at 428, in the old `gap`; `capped` at 456, in the old `reserved` |
| Mandate | 384 | 384 | 315: 1 to 2 | nothing |
| MintCap | 136 | 136 | 76: 1 to 2 | `total_limit` at 80, `outstanding` at 88, `created_at` at 96, in the old `reserved` |
| Committee | 408 | 408 | 338: 1 to 2 | nothing |
| ClaimBoard | 176, or 168 before the stand-by line | 176 | 132: 1 to 2 | `head` at 168 and `tail` at 172 on a 168 board |
| Standby | 88 | 88 | 81: 0 to 1 | `version` at 81, in the old `padding` |
| Profile | 504 | 504 | 464: 1 to 2 | `encryption_key` at 472, in the old `reserved`; zero is no key |

`OUTDATED` in `programs/intent_engine/src/versions.rs` lists each layout `migrate` reads: these, and a version-1 config of the current size, which `main` wrote before it enforced versions.

`migrate` rewrites one such account in place. It keeps every byte, sets the version, and grows a config or a 168 board with zero bytes. The payer adds the rent difference between the two sizes, and more if needed so a board holds the larger size's rent on top of its held stake; the account never loses lamports. Anyone may send it; for the config the payer must be the admin. It refuses a current account with `AlreadyCurrent` and any other layout with `UnknownLayout`; `close_legacy` still closes those.

An open intent of the stand-by line records no fee: its fills paid the config's schedule at fill time. `migrate` sets `fee_bps` from the config's schedule for its kind, which is the fee it was charged at creation while the config's fee terms are unchanged since. On devnet no `update_config` or `update_economics` ran after the two open escrows in the fixture were created, so both record the attested fee, 300. As at creation, an open proof escrow keeps that fee only if its release still settles under it; otherwise `migrate` writes zero, so the escrow stays releasable, and sets `fee_dropped` in `AccountMigrated`. Intents that are not open keep zero, and an intent that already records a fee keeps it.

Refunds never wait for `migrate`: `cancel_intent`, `expire_intent` and `close_intent` read version-1 intents, cancelling reads 168 boards, and `close_legacy` closes mandates and profiles before they migrate, and boards and stand-by entries once their escrow has ended. `tests/svm/tests/devnet_migration.rs` loads every devnet account and shows each refund before and after migrating.

`node scripts/devnet-snapshot.mjs` saves every account the devnet program owns, with each intent's vault and input mint and the rent sysvar, to `tests/svm/fixtures/devnet.json`. It only reads, pausing and retrying when the node limits it. Refresh it before an upgrade and rerun `bash scripts/test.sh`.

```sh
intent-engine migrate --keypair payer.json --all --url devnet
intent-engine migrate --keypair payer.json --address <account> --url devnet
```

Without `--yes` both preview. `--all` lists every account the program owns, skips current ones, sends the rest in batches of `MIGRATE_BATCH` instructions, and reports counts per type, the rent it adds and every account it cannot read. When the signer is not the config's admin, as on devnet where the admin is the Squads vault, the output carries `config_proposal`: import its `transaction_base58` into the multisig as with `propose-admin --authority`. The admin pays the config's rent top-up, shown in `config.top_up_lamports`: send the vault that many lamports before the proposal executes. After the upgrade executes, run `--all`, then approve the config proposal.
## Publish the IDL

Once the vault is the upgrade authority, only the vault can write the program's canonical IDL. From a clean checkout at `origin/main`, after the upgrade has executed, run `bash scripts/idl.sh devnet --multisig <multisig>`. It prints the sha256 of `idl/intent_engine.json` as `idl/intent_engine.json hashes to <idl hash>`. The Solana CLI default keypair, or the file in `UPGRADE_AUTHORITY`, writes the file to a buffer and hands the buffer to the vault. The file in `MULTISIG_MEMBER` proposes one vault transaction that tops up the IDL account's rent, sets its data from the buffer and closes the buffer, whose rent goes back to that keypair.

Each member reads the proposal with `show --index <n>` before approving. The tool decodes every instruction of the program-metadata program `ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S` at the layout of `@solana-program/program-metadata@0.10.0`: its name, each account with its role, and its seed, encoding, compression, format, data source and data. For the update it prints:

- whether the metadata account is the canonical IDL account of `GHFB9q4fhhqRyCoycoivdxMhFkp1aLHJk5VvroUsgrJU` and whether the vault may change it as the program's upgrade authority;
- whether the program and program data accounts are the engine's;
- who controls the buffer, and the sha256 of the IDL bytes it sets, read through the instruction's compression and encoding; it has to equal `<idl hash>`;
- where the lamports of a closed buffer or IDL account go.

Such a proposal needs no override. `approve` signs it without `--allow-undecoded-vault-signer` and prints the IDL hash as `buffer_hash`: the sha256 of the IDL the simulated instructions leave in the IDL account, read through that account's compression and encoding, which `post_state` also lists. Two members approve and one executes with that hash:

```sh
node packages/multisig/dist/bin.js execute --multisig <multisig> --index <n> --expect-buffer-hash <idl hash> --keypair member-b.json --url devnet --yes
```

`execute` refuses without `--expect-buffer-hash`, and refuses when the buffer no longer decodes to `<idl hash>`, the vault no longer controls it, or the simulation of the exact transaction it sends leaves an IDL that does not hash to `<idl hash>`. `bash scripts/idl.sh devnet --check` then compares the published IDL with `idl/intent_engine.json` and exits non-zero when they differ.

## Refusals

`approve` and `execute` sign only a vault transaction they decode in full and refuse anything else with a JSON error that carries the decoded summary:

- a proposal that loads accounts from address lookup tables, or that this tool cannot decode: `show` lists it as `Undecodable`;
- a message that asks any key other than the vault, or the transaction's ephemeral signers, to sign: executing it would lend the executing member's signature to a hidden instruction;
- an upgrade or IDL update whose buffer is missing, does not decode, or is controlled by anyone but the vault, since its code or IDL could change after approval;
- an upgrade or IDL update whose buffer an earlier instruction of the same proposal may write, without `--allow-rewritten-buffer`, as in [Simulated post-state](#simulated-post-state);
- a program-metadata instruction that does not decode at the `@solana-program/program-metadata@0.10.0` layout;
- on mainnet-beta, a loader Close of the engine's program data without `--allow-engine-close`, as in [Upgrade](#upgrade);
- an instruction that passes the vault as a signer to a program this tool does not decode in full, on every cluster, without `--allow-undecoded-vault-signer`. The vault's signature carries through every call that program makes, so it can change program code, hand over the upgrade authority or move the vault's funds where the summary cannot show it;
- a program-metadata instruction signed by the vault that does more than update the engine's IDL, on every cluster, without `--allow-undecoded-vault-signer`: one that acts on metadata other than the engine's canonical IDL account, names another program, passes the vault in a role other than the authority, hands the authority of the IDL account or a buffer to a key other than the vault, or closes or trims the IDL account into an address outside the vault;
- a Squads config transaction, which adds or removes members or changes the threshold or time lock. `show` prints each change and the members, threshold and time lock after it runs. Inspect it in the Squads app at https://app.squads.so and do not approve it blindly; `--allow-config` on `approve` and `execute` signs it once every printed change is expected.

The tool decodes in full the intent engine, the upgradeable loader and a system transfer, which it shows as `Transfers <sol> SOL (<lamports> lamports) from <vault> to <recipient>`. For any other program that the vault signs for, `show` adds a problem that names the instruction and the program. With `--allow-undecoded-vault-signer`, `approve` and `execute` put that problem first in the summary as a warning and sign. Pass it only for a program you trust with everything the vault holds and controls.

## Simulated post-state

An earlier instruction of a proposal can rewrite the buffer a later SetData or Upgrade reads, for example a program-metadata Write, Extend or Trim signed by the vault. The buffer's hash before the transaction then proves nothing about what lands. The review tracks, for each instruction, every account an earlier instruction of the same message passes as writable. A system transfer counts as no write, since it only moves lamports.

For such a buffer the review computes nothing: it reports a problem that names the writing instructions, sets the buffer's `hash` to null, lists the writers under `writtenBy`, and appends the same note to the instruction's summary. `approve` and `execute` refuse it unless the member passes `--allow-rewritten-buffer`.

Members then see what the transaction sets rather than what the buffer held. `approve` simulates the proposal's instructions as the vault and prints `post_state`: for every IDL account a SetData sets and every program data account an Upgrade sets, the sha256 of the IDL that lands, read through the account's compression and encoding, or of the program's code without trailing zeros. With one such account, `buffer_hash` is that hash. A failed simulation is printed under `post_state.simulation`, and `buffer_hash` falls back to the buffer as it stands.

`approve` runs the instructions as a top-level transaction, since a proposal that is not yet approved cannot run through Squads. A call the runtime refuses inside the Squads call, such as a loader Write, can therefore preview a hash. `execute --expect-buffer-hash` simulates the exact vault-execute transaction it sends, signed, and refuses when that simulation fails or when any IDL account or program data account it sets does not hash to an expected value.

## Reject or cancel

A member who does not expect a proposal votes against it:

```sh
node packages/multisig/dist/bin.js reject --multisig <multisig> --index <n> --keypair member-c.json --url devnet --yes
```

While the proposal is active, `reject` records a rejection; with 2 of 3, two rejections close it for good. Once a proposal is approved and waits out the time lock, `reject` records a cancellation instead; two cancellations close it before it executes.

## Recovery

With 2 of 3, losing one key stops nothing: the other two still approve and execute. Replace the lost key before a second one goes:

1. Make a new key and create a new 2-of-3 multisig from it and the two remaining keys, as in step 2. Its vault is `<new vault>`.
2. Through the old multisig, hand the upgrade authority to the new vault and propose it as admin:

   ```sh
   node packages/multisig/dist/bin.js propose-authority --multisig <multisig> --new-authority <new vault> --keypair member-a.json --url devnet --yes
   node packages/multisig/dist/bin.js propose-admin --multisig <multisig> --keypair member-a.json --url devnet --yes -- node packages/cli/dist/src/bin.js propose-admin --authority <vault> --new-admin <new vault> --url devnet
   ```

3. The two remaining members approve and execute both proposals.
4. Through the new multisig, accept the admin role as in step 4, with `<new vault>` as `--authority`.

A lost guardian key is replaced with `update-config --guardian` through the multisig, as in step 5. If two keys are lost, the multisig can no longer act: the program stays as it is and owners still cancel and reclaim their escrow, but nobody can upgrade it or change its config again.

## Monitoring

`monitor` reads the program and its config every `--interval` seconds, 30 by default, and compares them with a baseline file: every config field, every committee floor, the limits of every mint cap, the upgrade authority and the program hash, the value `solana-verify get-program-hash` prints. It signs nothing and needs no keypair. Write the baseline after each intended change, once `show config` and the program hash are what the proposal promised:

```sh
node packages/cli/dist/src/bin.js monitor --write-baseline /etc/intent-engine/baseline.json --url devnet
```

`--write-baseline` never overwrites a file; move the old baseline away first. Without `--expect` the monitor refuses to start.

The baseline holds `committeeFloors`, each mint with a committee floor and its raw floor, and `mintCaps`, each mint with a cap account and its `maxPerOrder`, `windowCap`, `windowSecs` and `totalLimit` as the program stores them. The monitor lists the program's accounts to find every mint cap. A baseline without these fields is refused; write a new one.

Every alert is one JSON line on stdout with `kind` (`config`, `upgrade-authority`, `program-hash`, `fill-amount`, `fill-rate`, `mint-cap`, `committee-floor`, `mint-cap-limit`, `balance`, `swap-wait` or `rpc`), `field`, `expected`, `observed` and `slot`. A `committee-floor` or `mint-cap-limit` alert also names the `mint`; a floor that is gone reads `0`, a cap that is gone or new reads `missing`. A change alerts once, not on every poll, until the baseline is rewritten and the monitor restarted. `--max-fill <mint>=<raw amount>`, repeatable, alerts on a fill above that amount of that input token; `--max-fills <count>` alerts when more fills land in one interval. A failed read, or a slot that does not advance for three intervals, is an `rpc` alert, never a quiet poll. `--webhook <https url>` also POSTs each alert as JSON; the monitor prints only the webhook's scheme and host, and a failed POST goes to stderr. `--once` checks once and exits 0 when nothing alerted and 4 when anything did. With `--once`, `--since <seconds>` sets how far back it reads fills, the interval by default.

`--min-balance <wallet>=<SOL>`, repeatable, raises a `balance` alert while that wallet holds less SOL than the floor; `field` and `wallet` name the wallet, `expected` the floor and `observed` its balance. `--max-swap-wait <seconds>` raises a `swap-wait` alert for each open intent the devnet filler would fill that has waited longer than that: it sells SOL for TEST, asks no more than the filler's `--issue` rate pays less its `--min-profit`, and its fees are within the filler's `--max-fee-bps`. `intent` names it and `waited` gives the seconds since it became fillable, by the chain's clock. Both read only the chain, and each alerts once until the wallet recovers or the intent leaves.

For each mint named in `--max-fill`, the monitor prints its mint cap's outstanding amount and total limit to stderr when it starts, and raises a `mint-cap` alert while the outstanding amount has reached the total limit.

Run it as a service on a host other than the members' machines, with a minimal systemd unit at `/etc/systemd/system/intent-engine-monitor.service`:

```ini
[Unit]
Description=intent engine monitor
After=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/solive/packages/cli/dist/src/bin.js monitor --expect /etc/intent-engine/baseline.json --url devnet --max-fills 50 --webhook https://hooks.example.com/<your hook>
Restart=always
User=monitor

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable --now intent-engine-monitor
journalctl -u intent-engine-monitor -f
```

`.github/workflows/monitor.yml` also runs `monitor --once` every hour, at minute 37, on GitHub against `monitoring/devnet.json`, first on the public devnet node and then on a second node when the `SECOND_DEVNET_RPC` secret holds its address. It passes `--since 3900`, so consecutive runs overlap, and `--max-fill` for wrapped SOL at 10 SOL in raw units. The first step also passes `--min-balance` for the filler's and the faucet's wallets and a `--max-swap-wait` above the filler's polling interval. The faucet's floor stays above its reserve plus one request on each faucet run between two checks: `.github/workflows/faucet.yml` runs several times between two checks, and `packages/cli/test/monitor-workflow.test.ts` holds the floor to that. A failed run is the alert: GitHub emails the repository owner. After each intended change, commit the new baseline, and update the command line version in the workflow when releasing.

Alerts go to the journal and to the webhook, which should page a person, for example a chat or paging service. After each intended change, write the new baseline and run `sudo systemctl restart intent-engine-monitor`. The monitor cannot report its own death: alert on the unit failing, and watch the webhook for silence.

## Devnet filler and faucet

The devnet filler fills the quickstart's swaps. `scripts/filler-install.sh` packs the workspace and installs it in `~/solive-filler` on the WSL filesystem, copies `filler.sh` and `faucet-topup.sh` beside it, and prints the installed command line version beside the published one. The installed `filler.sh` runs the command line next to it, so an edit in the checkout reaches the filler only through a new install. The unit at `/etc/systemd/system/solive-filler.service`:

```ini
[Unit]
Description=solive devnet filler
After=network-online.target

[Service]
User=dev
WorkingDirectory=/home/dev/solive-filler
Environment=FILLER_KEYPAIR=/home/dev/.config/intent-engine/filler.json
ExecStart=/bin/bash /home/dev/solive-filler/filler.sh
Restart=always
RestartSec=15
StandardOutput=append:/home/dev/filler.log
StandardError=append:/home/dev/filler.log

[Install]
WantedBy=multi-user.target
```

To upgrade, check out the release tag in the checkout, install, compare the two versions the install prints, and restart:

```sh
git fetch --tags
git switch --detach v<version>
bash scripts/filler-install.sh
sudo systemctl restart solive-filler
journalctl -u solive-filler -n 20
```

`scripts/faucet-topup.sh` refills the faucet wallet from a funding wallet. It refuses any node whose genesis hash is not devnet's. When the faucet holds less than `TOPUP_FLOOR` SOL it previews a transfer that brings it to `TOPUP_TARGET` SOL, and sends it only with `--yes`, printing the amount and the explorer link. `TOPUP_KEYPAIR` is the funding wallet's key file; `TOPUP_FAUCET`, `TOPUP_URL`, `TOPUP_FLOOR` and `TOPUP_TARGET` default to the devnet faucet's address, devnet and the values at the top of the script.

Run it weekly with `/etc/systemd/system/solive-faucet-topup.service`:

```ini
[Unit]
Description=solive devnet faucet top-up
After=network-online.target

[Service]
Type=oneshot
User=dev
Environment=PATH=/home/dev/.local/share/solana/install/active_release/bin:/usr/bin:/bin
Environment=TOPUP_KEYPAIR=/home/dev/.config/intent-engine/faucet-funding.json
ExecStart=/bin/bash /home/dev/solive-filler/faucet-topup.sh --yes
```

and `/etc/systemd/system/solive-faucet-topup.timer`:

```ini
[Unit]
Description=weekly solive devnet faucet top-up

[Timer]
OnCalendar=weekly
Persistent=true

[Install]
WantedBy=timers.target
```

As `dev`, preview once by hand, then enable the timer:

```sh
env TOPUP_KEYPAIR=/home/dev/.config/intent-engine/faucet-funding.json bash /home/dev/solive-filler/faucet-topup.sh
sudo systemctl daemon-reload
sudo systemctl enable --now solive-faucet-topup.timer
systemctl list-timers solive-faucet-topup.timer
```

## Incident

When an alert shows a change nobody proposed, the guardian raises the pause at once, alone:

```sh
node packages/cli/dist/src/bin.js raise-pause --keypair guardian.json --flags all --url devnet --yes
```

The admin can also raise it through the multisig, but that waits for two members. Funds still return while paused, as [Roles](#roles) describes.

Once the cause is fixed, the multisig lowers the pause:

```sh
node packages/multisig/dist/bin.js propose-admin --multisig <multisig> --keypair member-a.json --url devnet --yes -- node packages/cli/dist/src/bin.js lower-pause --authority <vault> --flags all --url devnet
```

Two members approve and one executes, as in step 4. `show config` then shows `paused` as 0.

Then rewrite the baseline. Check `show config`, the program hash and every mint cap against what the multisig approved, move the old baseline away and write a new one:

```sh
mv monitoring/devnet.json /tmp/devnet-before.json
node packages/cli/dist/src/bin.js monitor --write-baseline monitoring/devnet.json --url devnet
diff /tmp/devnet-before.json monitoring/devnet.json
```

Commit the new baseline once every difference is one the multisig approved, and restart the monitor service.

## Signing with a Ledger

`--keypair` and `--create-key` also take a Ledger, in the Solana CLI's form: `usb://ledger` derives `m/44'/501'`, `usb://ledger?key=<account>` derives `m/44'/501'/<account>'` and `usb://ledger?key=<account>/<change>` derives `m/44'/501'/<account>'/<change>'`. Any other `usb://` path is a usage error. A Ledger gets every check a keypair file gets: the full decode, the buffer hash and authority, the signer check and membership. A Ledger whose address is not a member is refused before it is asked to sign.

1. On the Ledger, install the Solana app with Ledger Live, open it and turn on blind signing in its settings. The app cannot decode Squads instructions, so it signs them by message hash and refuses them while blind signing is off.
2. Build the USB driver once per checkout; pnpm skips its install script:

   ```sh
   (cd node_modules/.pnpm/node-hid@2.1.2/node_modules/node-hid && node ../prebuild-install/bin.js --runtime napi)
   ```

   On Linux, install Ledger's udev rules from https://github.com/LedgerHQ/udev-rules as well.
3. `solana-keygen pubkey "usb://ledger?key=0"` prints the member address of account 0. Use that address in `--members`.
4. Sign as with a file:

   ```sh
   node packages/multisig/dist/bin.js approve --multisig <multisig> --index <n> --keypair "usb://ledger?key=0" --url devnet
   node packages/multisig/dist/bin.js approve --multisig <multisig> --index <n> --keypair "usb://ledger?key=0" --url devnet --yes
   ```

   The preview reads the Ledger's address and never asks it to sign. With `--yes`, before the Ledger asks, stderr shows the summary and `message hash: <hash>`, the base58 sha256 of the transaction message, and the JSON output carries it as `message_hash`. The Ledger shows the same hash: compare the two and press approve only if they match. A locked or missing Ledger, a closed Solana app, blind signing turned off and a rejection on the device each refuse with their own message, and nothing is sent.
5. One Ledger per member, kept by that member and never shared; the seed phrase backup sits on paper or steel, apart from the device.

A member who loses their Ledger and its seed phrase is replaced inside the same multisig. Another member creates a Squads config transaction in the Squads app at https://app.squads.so that removes the lost address and adds the new one. Each member reads it with `show`, which prints each change and the members after it, and signs it with `--allow-config`:

```sh
node packages/multisig/dist/bin.js show --multisig <multisig> --index <n> --url devnet
node packages/multisig/dist/bin.js approve --multisig <multisig> --index <n> --allow-config --keypair "usb://ledger?key=0" --url devnet --yes
node packages/multisig/dist/bin.js execute --multisig <multisig> --index <n> --allow-config --keypair "usb://ledger?key=0" --url devnet --yes
```

## Real keys

The devnet members are files on one machine. Before mainnet:

- Each member key lives on a hardware wallet, held by a different person on a different device. Members with a Ledger sign through this tool as [Signing with a Ledger](#signing-with-a-ledger) shows, so they keep its checks; the Squads app at https://app.squads.so shows the same multisig but not those checks.
- No member key ever touches the machine that builds or deploys.
- Each person keeps an offline backup of their seed phrase, on paper or steel, in a separate place from the device.
- The guardian key sits on a host that runs nothing else and is watched, so a pause is fast.
- Run the steps above on devnet with the real keys first, including one recovery drill, and set a time lock so the members can [reject or cancel](#reject-or-cancel) a proposal they did not expect before it executes.

## Proofs

`bash scripts/kani.sh` runs every Kani proof in `tests/proofs`, and the CI `kani` job runs the same script. The money logic the proofs cover lives in `crates/intent-core` as pure functions the program calls. Proofs over a sequence of steps are bounded so each finishes on a normal machine:

| File | What it proves | Bound |
| --- | --- | --- |
| `settle.rs` | `release_settles` holds exactly when the rest after the judge fee splits, and a settling release pays out exactly the amount | none, all inputs |
| `stakes.rs` | the release, cancel and settle stake decisions agree on one party: a lapsed claim pays the owner, a held one never does | up to 2 payees |
| `caps.rs` | outstanding equals the live intents' capped amounts and stays within `total_limit`; refunds never let a later charge pass the live total; an older intent's refund never lowers a recreated cap | 3 steps over 2 intents |
| `top_up.rs` | a migration top-up never lowers lamports and leaves the new size's rent plus the held stake | none, all inputs |
| `line.rs` | join and pass keep `head <= tail`, never skip or repeat a place, and `waiting()` counts joined minus served; serving hands out the first present place | 4 steps; a line of up to 4 places for serving |

## Dependencies

`bash scripts/supply-chain.sh` runs in the CI audit job and fails when:

- a dependency of a published package is a range instead of an exact version or `workspace:*`;
- the production tree of a published package, every transitive `name@version` in `pnpm-lock.yaml`, differs from its file in `supply-chain/`, such as `supply-chain/cli.txt`; it prints the added and removed lines;
- an installed package declares a `preinstall`, `install` or `postinstall` script, or a `binding.gyp`, and `pnpm-workspace.yaml` lists it in neither `onlyBuiltDependencies` (its script runs) nor `ignoredBuiltDependencies` (it does not). `strictDepBuilds: true` makes `pnpm install` fail on the same packages on every platform.

To add or change a dependency:

1. Set an exact version in `package.json` and run `pnpm install`.
2. Run `bash scripts/supply-chain.sh` and read every added and removed line: who publishes the package, its install scripts, its last release date.
3. A new install script goes under `ignoredBuiltDependencies` unless the package fails without it; then review the script and list it under `onlyBuiltDependencies`.
4. Run `bash scripts/supply-chain.sh --write` and commit the tree files with the change, so the review shows the tree diff. `--write` never edits `pnpm-workspace.yaml` or `package.json`.

A checkout installed before `strictDepBuilds` still records the scripts it skipped in `node_modules`, and `pnpm install` then stops with `ERR_PNPM_IGNORED_BUILDS` even for packages listed under `ignoredBuiltDependencies`. Delete `node_modules` once and install again.

## Release

A tag `v<version>` on a commit whose `ci` run passed starts `.github/workflows/release.yml`. It waits for approval in the `npm` environment, then `scripts/release.sh` checks that every package and `packages/cli/src/version.ts` carry the tagged version, builds and packs them, and publishes core, client, solver and cli in that order with npm provenance. A version already on npm is skipped, so a rerun finishes a partial release.

The workflow holds no npm token: it signs in through npm trusted publishing. Each package must list this repository and `release.yml` as a trusted publisher on npmjs.com, and refuse publishing with tokens, before the gap in [T-51](threat-model.md) closes.

To release, bump the versions as in a `Release x.y.z` commit, push it, wait for `ci`, then push the tag: `git tag v<version>` and `git push origin v<version>`.

Before pushing the tag, build as in [Tools](#tools) and run `bash scripts/mcp-smoke.sh devnet <hirer key> <worker key> <spec url>` with two funded devnet keys and an https url serving any spec. It drives a hirer's and a worker's `intent-engine mcp --wallet` through one paid job of 0.01 SOL plus fees, previewing each step before it sends, and prints one line per step and the release signature. A failing step prints its name and the tool's problem; fix it before tagging.
