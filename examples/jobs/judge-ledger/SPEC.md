# Job: judge with a Ledger

`intent-engine judge` signs releases with a key file, so a judge's key sits on disk (threat-model rows T-55 and T-57). The command line already signs transactions on a Ledger for the commands in `LEDGER_COMMANDS` (`packages/cli/src/ledger-keys.ts`).

## Build

- `intent-engine judge`, including `judge --watch`, accepts `--keypair usb://ledger` and the other Ledger path forms, and signs each release on the device.
- If any step of judging signs a message rather than a transaction, the command refuses a Ledger path before reading the chain, as other message-signing commands do today, and the docs say so.
- A missing, locked or app-closed Ledger, and a rejection on the device, give the existing Ledger messages and send nothing; with `--watch`, a rejected release is reported and the watch goes on to the next delivery.

## Rules

- A Ledger path never falls back to a key file, and no command prints or stores key material.
- Reuse the Ledger signer from `@intent-engine/client` and the mock transport its tests use; tests use no device.
- Follow `CONTRIBUTING.md`: no code comments, a test for every behaviour, nothing bypassed.
- Update `docs/judge.md` in at most three short sentences and regenerate `docs/reference`. Change only `packages/cli` and `docs`.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. Tests cover: a release signed through the mock Ledger reaching the transport with the device's signature, each Ledger error and a device rejection sending nothing, and `--watch` continuing after a rejection.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
