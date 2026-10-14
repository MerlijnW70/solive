# Operations

Who holds the engine's power, and the exact steps to move it to a multisig. The [threat model](threat-model.md) lists this as T-52.

## Roles

| Role | Can | Target holder |
| --- | --- | --- |
| upgrade authority | replace the program | the vault of a 2-of-3 Squads v4 multisig |
| config admin | set fees, kinds, the guardian and the fee recipient; raise and lower pauses; hand over the admin role | the same vault |
| guardian | raise pause flags, nothing else | a separate key, outside the multisig |

The guardian acts alone and at once, because a pause has to be fast; a stolen guardian key can only pause, and the admin lowers the pause. Every other change waits for two of the three members.

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

`node packages/multisig/dist/bin.js` drives the multisig: `create`, `propose-upgrade`, `propose-authority`, `propose-admin`, `approve`, `execute`, `reject` and `show`. It talks to Squads v4 at `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`. Every command that sends prints a preview and a simulation and sends only with `--yes`. Every command prints JSON and refuses with a JSON error, for example when the signer is not a member or a proposal has too few approvals. `--url` prints only the scheme, host and port of the RPC url, so an API key in its path or query stays out of the output. `node packages/cli/dist/src/bin.js` is the engine CLI; with `--authority <address>` an admin command prints its instructions unsigned instead of sending them, and `propose-admin` wraps exactly those instructions in a proposal.

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

Approve it with two members and execute it as in step 4. `show config` then names `<guardian>` as guardian. `admin.json` now holds no role. Every later admin change, such as `set-economics`, `update-config`, `raise-pause` or `lower-pause`, goes through `propose-admin` with `--authority <vault>` in the same way.

## Upgrade

1. CI builds the program verifiably and prints its hash, `<hash>`.
2. From a clean checkout at `origin/main`, run `bash scripts/deploy.sh devnet <hash> --multisig <multisig>`. The Solana CLI default keypair, or the file in `UPGRADE_AUTHORITY`, pays for the buffer; the file in `MULTISIG_MEMBER`, by default the same key, proposes and has to be a member. It checks the cluster genesis, a clean tree, that HEAD is `origin/main`, that the program is upgraded by the vault and that the build hashes to `<hash>`. It writes the build to a buffer, checks the buffer hash, hands the buffer to the vault and proposes the upgrade. It executes nothing.
3. Each approving member reads the proposal first: `show --index <n>` prints `Upgrades program GHFB9q4fhhqRyCoycoivdxMhFkp1aLHJk5VvroUsgrJU to the code in buffer <buffer>, signed by <vault>; the buffer's rent goes to <spill>; the buffer hashes to <hash> and is controlled by <vault>`. `approve` refuses unless the buffer exists and the vault controls it, and prints the hash as `buffer_hash`; it has to equal `<hash>`, the same value `solana-verify get-buffer-hash --url devnet <buffer>` prints.
4. Two members approve and one executes with the hash it approved:

   ```sh
   node packages/multisig/dist/bin.js execute --multisig <multisig> --index <n> --expect-buffer-hash <hash> --keypair member-b.json --url devnet --yes
   ```

   `execute` refuses without `--expect-buffer-hash`, and checks again right before it sends that the vault still controls the buffer and that the buffer still hashes to `<hash>`.
5. `solana-verify get-program-hash --url devnet GHFB9q4fhhqRyCoycoivdxMhFkp1aLHJk5VvroUsgrJU` prints `<hash>`.

## Refusals

`approve` and `execute` sign only a vault transaction they decode in full and refuse anything else with a JSON error that carries the decoded summary:

- a proposal that loads accounts from address lookup tables, or that this tool cannot decode: `show` lists it as `Undecodable`;
- a message that asks any key other than the vault, or the transaction's ephemeral signers, to sign: executing it would lend the executing member's signature to a hidden instruction;
- an upgrade whose buffer is missing or controlled by anyone but the vault, since its code could change after approval;
- a Squads config transaction, which adds or removes members or changes the threshold or time lock. `show` prints each change and the members, threshold and time lock after it runs. Inspect it in the Squads app at https://app.squads.so and do not approve it blindly; `--allow-config` on `approve` and `execute` signs it once every printed change is expected.

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

## Real keys

The devnet members are files on one machine. Before mainnet:

- Each member key lives on a hardware wallet, held by a different person on a different device. The multisig tool reads keypair files only, so members with a hardware wallet read, approve and execute proposals in the Squads app at https://app.squads.so, which shows the same multisig.
- No member key ever touches the machine that builds or deploys.
- Each person keeps an offline backup of their seed phrase, on paper or steel, in a separate place from the device.
- The guardian key sits on a host that runs nothing else and is watched, so a pause is fast.
- Run the steps above on devnet with the real keys first, including one recovery drill, and set a time lock so the members can [reject or cancel](#reject-or-cancel) a proposal they did not expect before it executes.
