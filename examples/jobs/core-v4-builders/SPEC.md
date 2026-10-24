# Job: Build delivery v4 instructions in core TypeScript

The program on branch `v4-program` records delivery announcements on chain (delivery v4). A proof escrow now settles only against the paid worker's announcement, and six instructions are new. The generated client in `packages/core/generated` is already regenerated; `@intent-engine/core` must build, sign and decode all of it.

Read first: the program in `programs/intent_engine/src` (instructions `announce_delivery`, `set_announce_fee`, `sync_committee_keys`, `close_announcement`, `close_delivery_book`, `refute_release`, and the changed `fill_attested`, `fill_attested_committee`, `fill_attested_split`, `fill_attested_split_committee`, which now take `fill: Fill` and `opening: Opening` plus an `announcement` account), `programs/intent_engine/src/attested.rs`, and the Rust tests in `tests/svm/tests/delivery_release.rs`, `announcements.rs`, `committee_announcements.rs`, `announcement_close.rs` and `refute.rs`, which show every rule. The pure rules and preimages are already mirrored in `packages/core/src/delivery.ts` and `packages/core/src/sig.ts` (`attestedDeliveryPreimage`, `attestedSplitDeliveryPreimage`).

## Required

- The four settlement builders in packages/core/src/fill-builders.ts build the new instructions. Their inputs take the announcement address and the opening (delivered sha256 and salt) for a proof escrow; the types make it impossible to pass an opening without an announcement or the reverse.
- The judge-side message builders sign the new preimages: a single judge signs `attestedDeliveryPreimage`, a committee member signs the committee digest over it, and split cosigners sign the split digest over `attestedSplitDeliveryPreimage`. Every place in packages/core that built a proof or split release digest from the old `AttestedProof` or `AttestedSplit` preimage uses the delivery preimage instead.
- Builders for `announce_delivery`, `set_announce_fee`, `sync_committee_keys` (member profiles as remaining accounts, in member order), `close_announcement`, `close_delivery_book` and `refute_release`, in a new file packages/core/src/delivery-builders.ts, exported from the package root.
- Addresses: the announcement address (intent, worker, sha256 of the blob), the delivery book address (intent) and the refutation address (earlier announcement), next to the other PDA helpers.
- The seven new events decode like the existing ones (`DeliveryAnnounced`, `DeliveryReleased`, `CommitteeKeysSynced`, `AnnouncementClosed`, `DeliveryBookClosed`, `ReleaseRefuted`, `AnnounceFeeSet`), and the three new accounts (`Announcement`, `DeliveryBook`, `Refutation`) are known to packages/core/src/versions.ts with the same layout facts as programs/intent_engine/src/versions.rs.
- Tests for each change.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Do not change the program, the Rust crates, or the generated client by hand. Keep TypeScript files under about 500 lines.
- Only packages/core changes. Do not touch packages/core/src/sealed-delivery.ts; another job rewrites the sealed format in parallel. New source files go into the `sources:` list of your worktree's copy of `packages/core/noha.yaml`.
- The other packages (client, solver, cli) are adapted by later jobs and may fail to typecheck against your core; that is expected on this branch.

## Acceptance

1. With the patch applied to branch `v4-program` at the commit the delivery names: `cargo test --workspace` passes, and in packages/core `bash scripts/test.sh /mnt/f/solive all` passes (typecheck and every core test, including the golden and differential tests).
2. A LiteSVM test in packages/core, built only from the new core builders, announces for a proof escrow, settles it with a judge's signature over `attestedDeliveryPreimage`, and checks the `DeliveryReleased` event and the paid announcement; a second test settles a committee escrow with member votes over the new digest; a third has an earlier worker refute a release paid to a later announcer; a fourth closes an announcement and the book after the escrow is cancelled.
3. A test fails when the judge swaps two fields in the settle message the builders sign.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
