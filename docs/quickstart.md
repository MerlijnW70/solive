# Quickstart

Swap SOL for a test token on Solana devnet, then cancel an order. Devnet tokens have no value.

You need [Node.js](https://nodejs.org) 22.12 or later.

## 1. Install

```sh
npm install -g @intent-engine/cli
```

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

A solver on devnet fills it. Check your balance:

```sh
intent-engine balance
```

TEST shows `5` once it is filled.

## 4. Cancel

Ask for 50 TEST, more than the solver pays, then cancel it:

```sh
intent-engine create swap --input-mint SOL --output-mint TEST --units tokens --amount-in 0.05 --min-out 50 --expires-in 3600 --yes
intent-engine list
intent-engine cancel --nonce 1 --close --yes
```

Your 0.05 comes back as wrapped SOL.

## Next

- [Use it from your AI](ai.md)
- [Build in TypeScript](sdk.md)
- [All commands](reference/cli.md)
