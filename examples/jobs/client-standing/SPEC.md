# Job: Worker standing from announcements, releases and refutations

On branch `v4-program` deliveries are on-chain announcements (delivery v4) and `@intent-engine/client` already announces, lists and releases through them (packages/client/src/announce.ts, announcement-reads.ts, first-opening.ts, release-plan.ts). Reputation, trust and release confirmation (packages/client/src/reputation.ts, trust.ts, confirm-release.ts, release-reads.ts) were only kept compiling. This job rebuilds them on the v4 records and fixes two gaps in `firstOpening` and `announcements`.

Read first: programs/intent_engine/src/events.rs (`DeliveryAnnounced`, `DeliveryReleased`, `AnnouncementClosed`), programs/intent_engine/src/instructions (`announce_delivery`, `close_announcement`, `refute_release`, the four `fill_attested*`), programs/intent_engine/src/state.rs (`Announcement`, `Refutation`), packages/core/src/sealed-delivery-v4.ts (`openWithEsk`, `openDeliveryV4`), and the client files named above.

## Background

- Announcement accounts are not permanent: a worker closes its own after the escrow ends, and anyone closes a paid one after the refute window. A worker's record therefore comes from events, which stay in transaction history: `DeliveryAnnounced` in the worker's own signed transactions, and `DeliveryReleased` in the history of each of its announcement addresses (that history stays readable after the account is closed).
- Refutation accounts are permanent. A refutation proves only that an earlier announcement's commitment opens to the paid work. It substantiates a complaint only when the stored blob also opens under the revealed `esk` at every slot to that work: `openWithEsk` with the recipients the blob was sealed to.
- A slot sealed to a key the opener holds that does not unwrap to the committed content key can never open for anyone, including under a revealed `esk`. Such an announcement is not a delivery.

## Required

1. `firstOpening` no longer refuses with `does-not-open`. An announcement sealed to a key the caller holds that does not open with it is skipped, and the result lists it in `skipped` (address, seq, worker, reason `does-not-open`). Refusals for `incomplete`, `key-not-given` and `claim-held` stay. This applies to key judges and committee members alike.
2. `announcements(intent)` is complete only when every seq from 1 to the book's `nextSeq - 1` is present exactly once. When the escrow's book is gone or the escrow is no longer open the list says so (`closed: true`) instead of claiming completeness it cannot know.
3. `reputationOf(wallet)` builds the record from:
   - `DeliveryAnnounced` events in the wallet's signed history (validated as emitted by the engine program through its event authority, as the client already validates events);
   - for each announcement, its `DeliveryReleased` event read from that announcement address's history, taken only from a transaction that settled that escrow;
   - the escrow's `IntentAttested` or split payees for amounts and co-authors: a wallet is credited as a co-author only when it is a payee of a split release, from that release, never from its own announcement on the escrow;
   - Refutation accounts whose paid announcement is one of the wallet's, each classified as `substantiated`, `unsubstantiated` or `unverifiable` (the recipients' keys can no longer be known). Only substantiated refutations count against the paid worker; the others are listed.
   - `WorkRecord.outcome` keeps its values; each record names its announcement, seq, release signature and role (`announcer` or `co-author`). The result says `complete: false` with a reason whenever a page limit or an unreadable account cut the record short.
4. `trustOf` uses the rebuilt records: an edge from payer to worker exists only for a paid record whose release the reputation read verified, and never for a self-dealt one. Its options and result shape stay unless the spec says otherwise.
5. `confirmOnBoth` compares the two nodes' views of the escrow, the book, the announcements up to the first opening, and the first opening itself; every `FirstOpeningRefused` reason becomes a comparable view value instead of a throw, so two nodes that refuse for the same reason agree. `ConfirmTarget.pages` and the `profile history` field go.
6. Remove what nothing uses: `landedBefore`, the history scans for deliveries the accounts now answer, and exports only those used.
7. docs/sdk-client.md describes standing, skipped announcements and the completeness rule; every new sentence is pinned by a test as the page's other sentences are.
8. Tests for each change.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Do not change the program, the Rust crates or packages/core except to fix a bug you can show with a test (report it). Keep TypeScript files under about 500 lines.
- Only packages/client and docs/sdk-client.md change. packages/cli and packages/solver are adapted by a later job and may fail to typecheck on this branch; that is expected.
- Keep the public names `reputationOf`, `trustOf`, `confirmOnBoth`, `nodeView`, `firstOpening` and `announcements`; list every changed exported type or field in the report so the CLI job can follow.

## Acceptance

1. With the patch applied to branch `v4-program` at the commit the delivery names: `cargo test --workspace` passes, packages/core passes `bash scripts/test.sh /mnt/f/solive all`, and packages/client passes its typecheck and every test.
2. A LiteSVM test: a griefer announces a blob under the judge's real fingerprint that does not open, then the honest worker announces; `firstOpening` skips the griefer, lists it in `skipped`, and a release pays the honest worker. The same holds for a committee member whose slot does not open.
3. A test where the book's `nextSeq` is past the last listed announcement shows the list incomplete and the release refused.
4. A LiteSVM test: two workers announce the same work, the judge pays the later one, the earlier one refutes; reputation of the paid worker counts the refutation as substantiated. A second refutation whose earlier blob does not open under its `esk` is listed as unsubstantiated and not counted.
5. A LiteSVM test: a paid announcement is closed after the refute window, and the worker's reputation still shows the paid record with its release.
6. A LiteSVM split test: the co-author payee is credited from the split release; a wallet that announced on the escrow but is not a payee is not credited.
7. A test fails when the judge makes `firstOpening` refuse again on an announcement that does not open with the caller's key, and another fails when the judge makes reputation count an unsubstantiated refutation.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
