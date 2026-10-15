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

Approve it with two members and execute it as in step 4. `show config` then names `<guardian>` as guardian. `admin.json` now holds no role. Every later admin change, such as `set-economics`, `update-config`, `raise-pause`, `lower-pause`, `set-mint-cap` or `set-caps-required`, goes through `propose-admin` with `--authority <vault>` in the same way.

## Staged caps

Escrow caps bound what one program bug can reach. Each input mint gets a cap account with two limits: the most one intent escrows, and the most all new intents together escrow in a window of seconds. Start the limits small and raise them as the program earns trust.

1. Give every mint the engine trades a cap. Amounts are raw units of the mint; the program refuses a window shorter than `MIN_CAP_WINDOW_SECS` in `programs/intent_engine/src/state.rs`:

   ```sh
   node packages/multisig/dist/bin.js propose-admin --multisig <multisig> --keypair member-a.json --url devnet --yes -- node packages/cli/dist/src/bin.js set-mint-cap --authority <vault> --mint <mint> --max-per-order <raw> --window-cap <raw> --window-secs 3600 --url devnet
   ```

   The first proposal for a mint creates its cap and the vault pays the rent; later proposals change the limits and keep the current window. Approve and execute as in step 4. `show` decodes it as `Intent engine SetMintCap {"maxPerOrder":"<raw>","windowCap":"<raw>","windowSecs":3600}, signed by <vault>`.
2. Check each cap and its current window:

   ```sh
   node packages/cli/dist/src/bin.js show mint-cap --mint <mint> --url devnet
   ```

3. Require caps. From then on every create passes its input mint's cap, and the engine refuses intents selling a mint without one:

   ```sh
   node packages/multisig/dist/bin.js propose-admin --multisig <multisig> --keypair member-a.json --url devnet --yes -- node packages/cli/dist/src/bin.js set-caps-required on --authority <vault> --url devnet
   ```

Every create names an optional mint cap account; a create without a cap passes the program id in its place. While caps are off, creates ignore the cap even when one is passed. The SDK, the CLI and the MCP tools pass the input mint's cap whenever it exists, so caps can be set before they are required. Clients built from 0.1.26 or earlier stop working on create once this program is deployed, because the create account lists changed. `set-caps-required off` lifts the requirement. Clients built from 0.1.26 or earlier also cannot release proof escrows on a program with job claims, because the release account lists gained the optional claims board and stake account; use 0.1.27 or later. Since the cancel of a claimed escrow passes its claims board, clients built from 0.1.28 or earlier cannot cancel an escrow whose owner opened claims; use 0.1.29 or later. A cap limits how fast escrow grows per mint, not the total held: intents created in earlier windows stay open until they fill, expire or are cancelled.

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

A build larger than the program's data account fails at `execute` with `account data too small for instruction`. `solana program show GHFB9q4fhhqRyCoycoivdxMhFkp1aLHJk5VvroUsgrJU --url devnet` prints that size as `Data Length`. Before executing, any key can grow it with `solana program extend GHFB9q4fhhqRyCoycoivdxMhFkp1aLHJk5VvroUsgrJU <bytes> --url devnet`, and pays the rent for the extra bytes.

## Publish the IDL

Once the vault is the upgrade authority, only the vault can write the program's canonical IDL. From a clean checkout at `origin/main`, after the upgrade has executed, run `bash scripts/idl.sh devnet --multisig <multisig>`. The Solana CLI default keypair, or the file in `UPGRADE_AUTHORITY`, writes `idl/intent_engine.json` to a buffer and hands the buffer to the vault; the file in `MULTISIG_MEMBER` proposes one vault transaction that tops up the IDL account's rent, sets its data from the buffer and closes the buffer. Two members approve and one executes, as in step 4 of the upgrade without `--expect-buffer-hash`. `bash scripts/idl.sh devnet --check` then compares the published IDL with `idl/intent_engine.json` and exits non-zero when they differ.

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

## Monitoring

`monitor` reads the program and its config every `--interval` seconds, 30 by default, and compares them with a baseline file: every config field, the upgrade authority and the program hash, the value `solana-verify get-program-hash` prints. It signs nothing and needs no keypair. Write the baseline after each intended change, once `show config` and the program hash are what the proposal promised:

```sh
node packages/cli/dist/src/bin.js monitor --write-baseline /etc/intent-engine/baseline.json --url devnet
```

`--write-baseline` never overwrites a file; move the old baseline away first. Without `--expect` the monitor refuses to start.

Every alert is one JSON line on stdout with `kind` (`config`, `upgrade-authority`, `program-hash`, `fill-amount`, `fill-rate` or `rpc`), `field`, `expected`, `observed` and `slot`. A change alerts once, not on every poll, until the baseline is rewritten and the monitor restarted. `--max-fill <mint>=<raw amount>`, repeatable, alerts on a fill above that amount of that input token; `--max-fills <count>` alerts when more fills land in one interval. A failed read, or a slot that does not advance for three intervals, is an `rpc` alert, never a quiet poll. `--webhook <https url>` also POSTs each alert as JSON; the monitor prints only the webhook's scheme and host, and a failed POST goes to stderr. `--once` checks once and exits 0 when nothing alerted and 4 when anything did.

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

Alerts go to the journal and to the webhook, which should page a person, for example a chat or paging service. After each intended change, write the new baseline and run `sudo systemctl restart intent-engine-monitor`. The monitor cannot report its own death: alert on the unit failing, and watch the webhook for silence.

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
