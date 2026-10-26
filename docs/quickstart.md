# Quickstart

Swap SOL for a test token on Solana devnet, then cancel an order. Devnet tokens have no value.

An order here is an intent: you lock what you sell, and a solver fills it with at least what you asked for.

You need [Node.js](https://nodejs.org) 22.12 or later.

## Devnet SOL

Every step sends a transaction, so your wallet needs devnet SOL. `setup` in step 2 asks devnet for it, but devnet often refuses. The other ways, each with the `address` that `setup` prints:

- `intent-engine setup --faucet`, with the [GitHub CLI](https://cli.github.com) signed in, files a request with this project's faucet and waits for the SOL. The faucet answers several times an hour, and `setup` prints how many minutes it waits at most.
- The faucet link `setup` prints opens the same request in a browser, as a public GitHub issue. It needs a GitHub account, and the same faucet answers it, so the SOL takes as long.
- Another devnet faucet, such as [faucet.solana.com](https://faucet.solana.com), takes your address and sends at once when it accepts the request.

This project's faucet sends 0.5 SOL, once a day per GitHub account. Run `setup` again once SOL arrives; it shows what your wallet holds.

## 1. Run the CLI

npx runs the CLI without installing anything globally:

```sh
npx -y @intent-engine/cli version
```

The steps below type `intent-engine`. Make that name run the same npx command in this shell:

```sh
alias intent-engine='npx -y @intent-engine/cli'
```

In Windows PowerShell, define it as a function instead:

```powershell
function intent-engine { npx -y @intent-engine/cli @args }
```

Or install the command globally:

```sh
npm install -g @intent-engine/cli
```

If the install fails with `EACCES`, install Node.js with a version manager such as nvm, or give npm a folder in your home directory, put it on your `PATH` and install again:

```sh
npm config set prefix ~/.npm-global
export PATH="$HOME/.npm-global/bin:$PATH"
npm install -g @intent-engine/cli
```

Add the `export` line to your shell's startup file, such as `~/.bashrc`, to keep it in new shells.

## 2. Make a wallet

```sh
intent-engine setup
```

This makes a devnet wallet, saves it as your default and asks devnet for 1 SOL. If devnet refuses, it names the ways in [Devnet SOL](#devnet-sol), with your address filled into the faucet link.

## 3. Swap

Offer 0.05 SOL for at least 5 TEST:

```sh
intent-engine create swap --input-mint SOL --output-mint TEST --units tokens --amount-in 0.05 --min-out 5 --expires-in 3600
```

This shows what will happen and sends nothing. On a wallet without SOL it still shows the terms, says the preview could not be simulated, and repeats how to get SOL. Add `--yes` to send it:

```sh
intent-engine create swap --input-mint SOL --output-mint TEST --units tokens --amount-in 0.05 --min-out 5 --expires-in 3600 --yes
```

A solver on devnet fills it while it is online. Check your balance:

```sh
intent-engine balance
```

TEST shows `5` once it is filled.

## 4. Cancel

Ask for 50 TEST, more than the solver pays, then cancel it:

```sh
intent-engine create swap --input-mint SOL --output-mint TEST --units tokens --amount-in 0.05 --min-out 50 --expires-in 3600 --yes
intent-engine list
```

`list` shows each order with its `nonce` and `status`. Cancel the one that is `open`, here nonce `1`:

```sh
intent-engine cancel --nonce 1 --close --yes
```

Your 0.05 comes back as wrapped SOL, SOL held as a token, which your next order can sell. A nonce your wallet has no order with is refused, with a pointer to `intent-engine list`.

## Sign with a Ledger

Install `@ledgerhq/hw-app-solana@7.12.0` and `@ledgerhq/hw-transport-node-hid-noevents@6.36.0` where intent-engine is installed, open the Solana app on the Ledger and pass `--keypair usb://ledger`, `usb://ledger?key=<account>` or `usb://ledger?key=<account>/<change>` instead of a key file. This works for `create`, `cancel`, `expire`, `close`, `approve`, `revoke-approval`, `deliver`, `refute`, `reclaim`, `claim-held`, `close-book`, `judge`, `committee vote`, `committee release`, `signed prepare`, `advance-nonce`, `advance-epoch`, `claims take`, `claims drop`, `mandate grant`, `mandate revoke`, `profile set`, `profile close` and `solver float`.

Any other command refuses a Ledger before it reads the chain and asks for a key file.

## Next

- [Use it from your AI](ai.md)
- [Build in TypeScript](sdk.md)
- [All commands](reference/cli.md)
