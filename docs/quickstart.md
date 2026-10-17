# Quickstart

Swap SOL for a test token on Solana devnet, then cancel an order. Devnet tokens have no value.

An order here is an intent: you lock what you sell, and a solver fills it with at least what you asked for.

You need [Node.js](https://nodejs.org) 22.12 or later.

## 1. Install

```sh
npm install -g @intent-engine/cli
```

If this fails with a permissions error, install Node.js with a version manager such as nvm and try again.

## 2. Make a wallet

```sh
intent-engine setup
```

This makes a devnet wallet, saves it as your default and asks devnet for 1 SOL. If devnet refuses, it prints where to get SOL instead.

## 3. Swap

Offer 0.05 SOL for at least 5 TEST:

```sh
intent-engine create swap --input-mint SOL --output-mint TEST --units tokens --amount-in 0.05 --min-out 5 --expires-in 3600
```

This shows what will happen and sends nothing. Add `--yes` to send it:

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

Your 0.05 comes back as wrapped SOL, SOL held as a token, which your next order can sell.

## Next

- [Use it from your AI](ai.md)
- [Build in TypeScript](sdk.md)
- [All commands](reference/cli.md)
