# Job: Seal deliveries in the v4 format with a key commitment

Delivery v4 stores each sealed delivery on chain in its announcement account (at most 624 bytes) and the program checks only its structure (`blob_head` in `crates/intent-core/src/delivery.rs`, mirrored in `packages/core/src/delivery.ts`). Today's v3 sealing (packages/core/src/sealed-delivery.ts) wraps one random content key per recipient with AES-GCM and does not commit to that key, so a worker can make two committee members open different content. v4 fixes this and fits the on-chain limits.

## The v4 blob (byte layout, the program enforces 1 and 2)

```
0          version = 4
1          n, the number of recipients, 1..=8
2          mask: bit i set when recipient i is a published encryption key (profile key), clear when it is the key derived from the wallet; mask >> n == 0
3          fp[n][8]: fingerprint of each recipient key = sha256("intent-engine-fp" || x25519 key)[0..8]
3+8n       epk[32]: ephemeral x25519 public key
+32        kc[32]: key commitment = sha256(KC_TAG || K)
+32        wrapped[n][32]: K xor HKDF-SHA256(ikm = x25519(esk, key_i), salt = epk || key_i, info = WRAP_INFO, 32 bytes)
+32n       ct: AES-256-GCM(key K, iv = 12 zero bytes, aad = INFO || intent || worker || bytes[0 .. 3+8n+64]) of salt16 || url, followed by its 16-byte tag
```

Length is `99 + 40n + U` where U, the url length, is 1..=200. Choose the tag strings KC_TAG, WRAP_INFO and INFO as fixed ASCII constants that differ from every tag already in core.

Secrets come from the worker's existing salt signature `sig` (an ed25519 signature over `saltMessage(intent, sha256)`): salt = the existing salt derivation; esk = x25519-clamped sha256(ESK_TAG || sig || url); K = sha256(CK_TAG || sig || url). The url is part of both so two blobs with different urls never share a pad. A worker whose signer cannot sign messages (a Ledger) instead uses 32 random bytes in place of `sig`, which `deliverySecrets` returns so the caller can keep it.

## Required

- In packages/core: `sealDeliveryV4`, `openDeliveryV4` (returns salt, url and K, and refuses a blob whose recipient slot unwraps to a key whose commitment is not `kc`), `openWithContentKey` (anyone holding K opens the same plaintext), `openWithEsk` (rebuilds every wrap from the revealed esk and the recipient keys, so a third party can check that a recipient could open the blob), and `deliverySecrets`, all in a new file packages/core/src/sealed-delivery-v4.ts exported from the package root. The v3 functions stay until the client moves off them in a later job.
- `maxSealedUrl(shape)`: the longest url that keeps the whole announce transaction within 1232 bytes for a given shape (recipient count, whether a relayer pays, whether a claims board, invite list and announce fee account are passed, and the two compute-budget instructions a client adds for a priority fee). It must agree with the Rust oracle `tests/svm/tests/announce_size.rs`: 200 for a worker announcing to a single judge or a committee of 8 without the optional accounts, 200 for a single judge in the heaviest shape, and exactly 116 for a committee of 8 in the heaviest shape. Compute it from a serialized transaction, not from a hand-kept table.
- Tests for each property, and tests that pin the layout byte by byte.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Use WebCrypto (`crypto.subtle`, X25519, HKDF, AES-GCM) as the v3 code does; add no dependency. Keep TypeScript files under about 500 lines.
- Only packages/core changes; do not touch fill-builders.ts, events.ts, versions.ts, pdas.ts or committee.ts (another job edits those in parallel). New source files go into the `sources:` list of your worktree's copy of `packages/core/noha.yaml`.

## Acceptance

1. With the patch applied to branch `v4-program` at the commit the delivery names, in packages/core `bash scripts/test.sh /mnt/f/solive all` passes, and `cargo test --workspace` passes.
2. Tests show: every recipient of one blob opens identical salt and url; a blob built with one slot wrapping a different key than the committed one is refused by that recipient; publishing K lets a non-recipient open it; a blob copied under another worker or another intent does not open; the same sig and url give the same blob and a different url gives a different esk and K; `openWithEsk` confirms an honest blob and refuses a garbage one; every blob `blobHead` accepts and every blob it refuses matches the Rust `blob_head` on the same bytes.
3. A test fails when the judge removes the key commitment check from `openDeliveryV4`.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
