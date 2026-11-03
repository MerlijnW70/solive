# Job: Signing tags and formats stay brand-neutral, sealing gets stricter (D10)

The deep audit (A1 M7, L25, L26; A3-04) found that signing domains and formats depend on the product name, against the rule that the brand lives only in `identity.toml` and on-chain and signing names stay neutral.

## Build

1. **Neutral tags.** The delivery salt tag (`packages/core/src/sealed-delivery-v4.ts`, built from `PRODUCT_SLUG` and signed by workers), the spec and feedback memo prefixes (`memo.ts`), the encryption key file kind (`encryption-key.ts`) and the sealed format tags (`sealed.ts`, written literally) must not change when the product is renamed. Use fixed neutral constants. Keep reading what was written under the current tags, so earlier announcements can still be refuted, earlier memos parsed, earlier key files loaded and earlier sealed files opened.
2. **Content key binds the intent.** The sealed-delivery content key is derived without the intent, under a fixed zero IV, so a caller that reuses a secret for two intents with the same url and recipients reuses key and nonce. Bind the intent and worker into the derivation, keeping the default path's output for existing deliveries readable.
3. **Explicit keys are checked like v4.** `sealed.ts` checks an explicit encryption key by length only; use the same usable-key check as v4.

## Tests

Each item has a test that fails without its fix: tags and prefixes are equal when the slug differs; an item written under the current tags still reads; equal secrets for two intents give different content keys; a small-order explicit key is refused.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only `packages/core` (`sealed-delivery-v4.ts`, `sealed.ts`, `memo.ts`, `encryption-key.ts`), their tests, and callers in `packages/client` or `packages/cli` only where an import or name must follow. No program change; if the on-chain commitment would change, stop and say so in the delivery.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested, with no weakened test, and old data still readable.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
