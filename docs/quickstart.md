# Quickstart

Create a swap intent on devnet, watch it fill, then cancel one nobody fills. Devnet SOL and the test token have no value, the devnet engine may be upgraded at any time, and the program has not had an external audit. Run every step in the same terminal: the `alias` and `export` lines last only for that shell. The `sh` blocks are for bash and zsh; steps 1 and 2 also show the Windows PowerShell form, and every later command runs unchanged in both.

## Prerequisites

- Node.js 22.12 or later
- pnpm 10.20.0
- Solana CLI, including `spl-token`

## 1. Install

```sh
git clone https://github.com/MerlijnW70/solive.git
cd solive
pnpm install
pnpm -r build
alias intent-engine="node $PWD/packages/cli/dist/src/bin.js"
```

In PowerShell, replace the `alias` line with:

```powershell
$cli = "$PWD/packages/cli/dist/src/bin.js"
function intent-engine { node $cli @args }
```

## 2. Create a devnet wallet

```sh
solana-keygen new --no-bip39-passphrase -o ~/solive-wallet.json
solana config set --url devnet --keypair ~/solive-wallet.json
export INTENT_ENGINE_URL=devnet INTENT_ENGINE_KEYPAIR=~/solive-wallet.json
```

In PowerShell:

```powershell
solana-keygen new --no-bip39-passphrase -o $HOME/solive-wallet.json
solana config set --url devnet --keypair $HOME/solive-wallet.json
$env:INTENT_ENGINE_URL = "devnet"
$env:INTENT_ENGINE_KEYPAIR = "$HOME/solive-wallet.json"
```

`intent-engine` expands a leading `~` in a keypair path to your home directory, so `--keypair ~/solive-wallet.json` works in both shells.

## 3. Fund it

```sh
solana airdrop 1
```

If the airdrop hits the rate limit, open a [devnet SOL request](https://github.com/MerlijnW70/solive/issues/new?template=faucet.yml) with the address `solana address` prints. It sends 0.5 devnet SOL, enough for this guide, once a day per GitHub account. It refuses GitHub accounts younger than 7 days and addresses that already hold 1 devnet SOL or more, and stops for the day after 50 requests.

## 4. Wrap SOL

The intent sells wrapped SOL for the solive test token `ETU8trkkfE8gNVPDGbCaJUoH88wy6yYV6ttJdc9NKB88`.

```sh
spl-token wrap 0.2
```

`spl-token wrap` pays the token account's rent out of the 0.2 SOL, so slightly less than 0.2 wrapped SOL arrives.

## 5. Create the intent

Sell 0.05 wrapped SOL for at least 5 test tokens:

```sh
intent-engine create swap --input-mint So11111111111111111111111111111111111111112 --output-mint ETU8trkkfE8gNVPDGbCaJUoH88wy6yYV6ttJdc9NKB88 --units tokens --amount-in 0.05 --min-out 5 --expires-in 3600
```

This prints what the intent does and sends nothing. Besides the escrow, creating pays rent for the intent's accounts and any create fee and crank bounty the engine charges. Add `--yes` to send it:

```sh
intent-engine create swap --input-mint So11111111111111111111111111111111111111112 --output-mint ETU8trkkfE8gNVPDGbCaJUoH88wy6yYV6ttJdc9NKB88 --units tokens --amount-in 0.05 --min-out 5 --expires-in 3600 --yes
```

## 6. Watch it fill

The devnet filler prices test tokens at 200 per wrapped SOL and pays exactly the minimum asked, so it fills this intent with 5. Check your balance:

```sh
spl-token balance ETU8trkkfE8gNVPDGbCaJUoH88wy6yYV6ttJdc9NKB88
```

Once the intent is filled, this prints `5`. The filler runs on one machine and is sometimes offline. If `intent-engine list` still shows the intent as `open`, it fills when the filler is back, unless it expires first, or cancel it as in step 7.

## 7. Cancel an intent nobody fills

Ask for 50 test tokens, more than the filler pays, then cancel:

```sh
intent-engine create swap --input-mint So11111111111111111111111111111111111111112 --output-mint ETU8trkkfE8gNVPDGbCaJUoH88wy6yYV6ttJdc9NKB88 --units tokens --amount-in 0.05 --min-out 50 --expires-in 3600 --yes
intent-engine list
intent-engine cancel --nonce 1 --yes
```

`list` shows this intent as `open` with nonce `1`. `cancel --yes` sends the cancel and returns its 0.05 wrapped SOL to your wrapped SOL token account; without `--yes` it only shows what it would do. The intent's rent stays in it until `intent-engine close` returns it to you, or pass `--close` with the cancel to get it back at once.

## Next

- [CLI reference](reference/cli.md)
- [MCP tools](reference/mcp-tools.md)
- [Errors](reference/errors.md)
- [Connect an AI agent](mcp.md)
- [Let an agent trade within limits](mandate.md)
- [Run a solver](solver.md)
- [Build on it from TypeScript](sdk.md)
