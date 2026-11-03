# Job: Deliver previews show every transaction and the announce fee (D13)

The deep audit of the CLI (A2 W3, W6, W12, W13, W14) found these faults in the deliver path.

## Build

1. **No unpreviewed second transaction on a device.** With a committee key sync, `wallet_deliver` on a Ledger previews only the sync, then builds and signs the announcement with no device preview, outside the one-at-a-time guard, and pairs the sync's message hash with the announcement's signature (`packages/cli/src/agent/wallet/delivery.ts`). On a device, stop after the sync with a `next` to call again, or preview both transactions, so every signed transaction was shown and approved, as the escrow, plan and worker paths already do.
2. **The announce fee is shown.** The program moves `config.announce_fee` to the fee recipient when it is above zero, but the MCP and CLI deliver previews say only rent and the transaction fee move (`delivery.ts`, `announce-commands.ts`); `wallet_worker` already counts it. Read the config and show the fee in both previews, from one shared helper.
3. **One copy of repeated texts and checks.** `ALREADY_ANNOUNCED` and `NOTHING_HELD` are written twice, the signature-format check four times, and encryption key files expand `~` in the MCP path but not in `sealed-commands.ts`. Use one of each.
4. **True texts.** `notAttestor` says "only that key can release it" also for committees; name the committee case. `openedSpec` (`agent/wallet/seal.ts`) turns an invalid encryption key file into "sealed, unchecked"; report the invalid key file instead.

## Tests

Each item has a test that fails without its fix: a mocked Ledger deliver that needs a committee sync signs exactly one transaction per call and returns a `next`; with a nonzero announce fee both previews name it; an encryption key path with `~` loads in the CLI; a committee escrow gets the committee text; an invalid key file is reported, not hidden.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only `packages/cli/src/agent/wallet/delivery.ts`, `seal.ts`, `held.ts`, `committee.ts`, `guard.ts` (key loading only), `announce-commands.ts`, `sealed-commands.ts`, a shared helper if needed, their tests and generated references. Do not touch `agent/wallet/attest.ts`, `split.ts`, `commands.ts` or `main.ts`. No program change.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
