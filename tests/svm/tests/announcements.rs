use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use intent_core::kinds::{attested_result, Kind};
use intent_engine::delivery::fingerprint;
use intent_engine::errors::EngineError;
use intent_engine::events::DeliveryAnnounced;
use intent_engine::state::{
    Announcement, DeliveryBook, ANNOUNCEMENT_VERSION, DELIVERY_BOOK_VERSION, PAUSE_FILL,
};
use litesvm::types::TransactionMetadata;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    anchor_error_at, book_pda, claim_job_ix, claim_list_pda, claims_pda, create_profile_ix,
    engine_error_at, events, intent_pda, load, open_claims_ix, open_claims_listed_ix,
    set_announce_fee_ix, swap_spec, test_blob, update_profile_ix, Announce, Env, IntentSpec,
    Market, TestResult, Trader,
};

const FUNDED: u64 = 2_000;
const ESCROW: u64 = 400;
const SPEC: [u8; 32] = [0x5a; 32];
const KEY: [u8; 32] = [3; 32];
const HOUR: u32 = 3_600;

struct World {
    env: Env,
    market: Market,
    trader: Trader,
    judge: Keypair,
    intent: Pubkey,
}

fn proof_spec(nonce: u64, attestor: &Pubkey, spec_hash: [u8; 32]) -> TestResult<IntentSpec> {
    Ok(IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: ESCROW,
            min_result: 1,
            max_result: 1,
            attestor: attestor.to_bytes(),
            spec_hash,
            judge_fee: 0,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ..swap_spec(nonce, ESCROW)?
    })
}

fn world() -> TestResult<World> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(anchor_spl::token::ID, &[], anchor_spl::token::ID, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let judge = env.funded()?;
    env.create_intent(&trader, &market, &proof_spec(0, &judge.pubkey(), SPEC)?)?;
    let intent = intent_pda(&trader.key.pubkey(), 0);
    Ok(World {
        env,
        market,
        trader,
        judge,
        intent,
    })
}

fn wallet_blob(fill: u8) -> Vec<u8> {
    test_blob(0, &[[0; 8]], 40, fill)
}

impl World {
    fn announce(&mut self, worker: &Keypair, blob: Vec<u8>) -> Announce {
        Announce::new(worker.pubkey(), self.intent, self.judge.pubkey(), blob)
    }

    fn send(
        &mut self,
        worker: &Keypair,
        a: &Announce,
    ) -> Result<TransactionMetadata, TransactionError> {
        self.env.send(worker, &[a.ix()], &[])
    }

    fn book(&self) -> TestResult<DeliveryBook> {
        load(&self.env.svm, &book_pda(&self.intent))
    }

    fn stored(&self, a: &Announce) -> TestResult<Announcement> {
        load(&self.env.svm, &a.address())
    }
}

#[test]
fn announcements_take_a_strict_sequence_in_execution_order() -> TestResult {
    let mut w = world()?;
    let mut sent = Vec::new();
    for fill in 0..8u8 {
        let worker = w.env.funded()?;
        let a = w.announce(&worker, wallet_blob(fill));
        let meta = w.send(&worker, &a)?;
        sent.push((a, meta.signature));
    }
    let seqs: Vec<u64> = sent
        .iter()
        .map(|(a, _)| w.stored(a).map(|s| s.seq))
        .collect::<TestResult<_>>()?;
    assert_eq!(seqs, (1..=8).collect::<Vec<u64>>());
    let mut by_signature: Vec<usize> = (0..sent.len()).collect();
    by_signature.sort_by_key(|i| sent.get(*i).map(|(_, s)| s.to_string()));
    assert_ne!(by_signature, (0..sent.len()).collect::<Vec<usize>>());
    let book = w.book()?;
    assert_eq!(
        (book.intent, book.next_seq, book.live, book.version),
        (w.intent, 9, 8, DELIVERY_BOOK_VERSION)
    );
    Ok(())
}

#[test]
fn an_announcement_records_its_worker_commitment_blob_and_terms() -> TestResult {
    let mut w = world()?;
    let worker = w.env.funded()?;
    let payer = w.env.funded()?;
    let mut a = w.announce(&worker, wallet_blob(9));
    a.payer = payer.pubkey();
    a.commitment = [0x42; 32];
    let meta = w.env.send(&payer, &[a.ix()], &[&worker])?;
    let stored = w.stored(&a)?;
    let intent = w.env.intent(&w.trader.key.pubkey(), 0)?;
    assert_eq!(
        (stored.intent, stored.worker, stored.attestor, stored.payer),
        (w.intent, worker.pubkey(), w.judge.pubkey(), payer.pubkey())
    );
    assert_eq!(stored.commitment, [0x42; 32]);
    assert_eq!(
        (stored.seq, stored.state, stored.recipients, stored.version),
        (1, 0, 1, ANNOUNCEMENT_VERSION)
    );
    assert_eq!(stored.expires_at, intent.expires_at);
    assert_eq!(usize::from(stored.blob_len), a.blob.len());
    assert_eq!(stored.blob.get(..a.blob.len()), Some(a.blob.as_slice()));
    assert_eq!(
        (stored.delivered, stored.salt, stored.paid_at),
        ([0; 32], [0; 16], 0)
    );
    let emitted = events::<DeliveryAnnounced>(&meta);
    assert_eq!(emitted.len(), 1);
    assert_eq!(
        emitted
            .first()
            .map(|e| (e.seq, e.worker, e.payer, e.commitment)),
        Some((1, worker.pubkey(), payer.pubkey(), [0x42; 32]))
    );
    Ok(())
}

#[test]
fn announcing_never_write_locks_the_intent() -> TestResult {
    let mut w = world()?;
    let worker = w.env.funded()?;
    let ix = w.announce(&worker, wallet_blob(1)).ix();
    let intent = ix.accounts.iter().find(|m| m.pubkey == w.intent);
    assert_eq!(intent.map(|m| m.is_writable), Some(false));
    Ok(())
}

#[test]
fn only_an_open_proof_escrow_takes_announcements() -> TestResult {
    let mut w = world()?;
    let worker = w.env.funded()?;
    let trader = w.trader.key.insecure_clone();
    let judge = w.judge.pubkey();
    w.env
        .create_intent(&w.trader, &w.market, &proof_spec(1, &judge, [0; 32])?)?;
    let plain = intent_pda(&trader.pubkey(), 1);
    let a = Announce::new(worker.pubkey(), plain, judge, wallet_blob(1));
    assert_eq!(
        w.send(&worker, &a).err(),
        Some(engine_error_at(0, EngineError::NotAProof))
    );
    w.env
        .create_intent(&w.trader, &w.market, &swap_spec(2, ESCROW)?)?;
    let swap = Announce::new(
        worker.pubkey(),
        intent_pda(&trader.pubkey(), 2),
        judge,
        wallet_blob(1),
    );
    assert_eq!(
        w.send(&worker, &swap).err(),
        Some(engine_error_at(0, EngineError::NotAProof))
    );
    let cancel = w
        .env
        .cancel_ix(&trader.pubkey(), &w.market, 0, &w.trader.input);
    w.env.send(&trader, &[cancel], &[])?;
    let late = w.announce(&worker, wallet_blob(2));
    assert_eq!(
        w.send(&worker, &late).err(),
        Some(engine_error_at(0, EngineError::InvalidTransition))
    );
    Ok(())
}

#[test]
fn announcing_stops_at_expiry_while_paused_and_with_a_wrong_attestor() -> TestResult {
    let mut w = world()?;
    let worker = w.env.funded()?;
    let mut wrong = w.announce(&worker, wallet_blob(1));
    wrong.attestor = Keypair::new().pubkey();
    assert_eq!(
        w.send(&worker, &wrong).err(),
        Some(engine_error_at(0, EngineError::AttestorMismatch))
    );
    let authority = w.env.authority.insecure_clone();
    let pause = w.env.raise_pause_ix(&authority.pubkey(), PAUSE_FILL);
    w.env.send(&authority, &[pause], &[])?;
    let paused = w.announce(&worker, wallet_blob(2));
    assert_eq!(
        w.send(&worker, &paused).err(),
        Some(engine_error_at(0, EngineError::FillPaused))
    );
    let mut fresh = world()?;
    let late_worker = fresh.env.funded()?;
    let expires_at = fresh.env.intent(&fresh.trader.key.pubkey(), 0)?.expires_at;
    fresh.env.set_now(expires_at);
    let late = fresh.announce(&late_worker, wallet_blob(3));
    assert_eq!(
        fresh.send(&late_worker, &late).err(),
        Some(engine_error_at(0, EngineError::InvalidTransition))
    );
    fresh.env.set_now(expires_at - 1);
    let last = fresh.announce(&late_worker, wallet_blob(4));
    fresh.send(&late_worker, &last)?;
    Ok(())
}

#[test]
fn a_blob_must_be_well_formed_carry_a_commitment_and_derive_its_address() -> TestResult {
    let mut w = world()?;
    let worker = w.env.funded()?;
    let mut bad = w.announce(&worker, wallet_blob(1));
    if let Some(version) = bad.blob.first_mut() {
        *version = 3;
    }
    assert_eq!(
        w.send(&worker, &bad).err(),
        Some(engine_error_at(0, EngineError::BlobMalformed))
    );
    let two = w.announce(&worker, test_blob(0, &[[0; 8], [0; 8]], 40, 1));
    assert_eq!(
        w.send(&worker, &two).err(),
        Some(engine_error_at(0, EngineError::BlobRecipients))
    );
    let mut zero = w.announce(&worker, wallet_blob(2));
    zero.commitment = [0; 32];
    assert_eq!(
        w.send(&worker, &zero).err(),
        Some(engine_error_at(0, EngineError::CommitmentZero))
    );
    let honest = w.announce(&worker, wallet_blob(3));
    let mut ix = honest.ix();
    let body = ix.data.len().saturating_sub(1);
    if let Some(last) = ix.data.get_mut(body) {
        *last ^= 1;
    }
    assert_eq!(
        w.env.send(&worker, &[ix], &[]).err(),
        Some(anchor_error_at(0, ErrorCode::ConstraintSeeds))
    );
    Ok(())
}

#[test]
fn a_judge_without_a_published_key_takes_only_wallet_sealed_blobs() -> TestResult {
    let mut w = world()?;
    let worker = w.env.funded()?;
    let keyed = w.announce(&worker, test_blob(1, &[fingerprint(&KEY)], 40, 1));
    assert_eq!(
        w.send(&worker, &keyed).err(),
        Some(engine_error_at(0, EngineError::BlobKeyMismatch))
    );
    let mut missing = w.announce(&worker, wallet_blob(2));
    missing.profile = false;
    assert_eq!(
        w.send(&worker, &missing).err(),
        Some(engine_error_at(0, EngineError::ProfileMismatch))
    );
    let wallet = w.announce(&worker, wallet_blob(3));
    w.send(&worker, &wallet)?;
    Ok(())
}

#[test]
fn a_judge_with_a_published_key_takes_only_blobs_sealed_to_that_key() -> TestResult {
    let mut w = world()?;
    let judge = w.judge.insecure_clone();
    w.env
        .send(&judge, &[create_profile_ix(&judge.pubkey(), KEY)], &[])?;
    let worker = w.env.funded()?;
    let wallet = w.announce(&worker, wallet_blob(1));
    assert_eq!(
        w.send(&worker, &wallet).err(),
        Some(engine_error_at(0, EngineError::BlobKeyMismatch))
    );
    let other = w.announce(&worker, test_blob(1, &[fingerprint(&[4; 32])], 40, 2));
    assert_eq!(
        w.send(&worker, &other).err(),
        Some(engine_error_at(0, EngineError::BlobKeyMismatch))
    );
    let keyed = w.announce(&worker, test_blob(1, &[fingerprint(&KEY)], 40, 3));
    w.send(&worker, &keyed)?;
    w.env
        .send(&judge, &[update_profile_ix(&judge.pubkey(), [5; 32])], &[])?;
    let stale = w.announce(&worker, test_blob(1, &[fingerprint(&KEY)], 40, 4));
    assert_eq!(
        w.send(&worker, &stale).err(),
        Some(engine_error_at(0, EngineError::BlobKeyMismatch))
    );
    Ok(())
}

#[test]
fn only_the_claim_holder_announces_while_a_claim_is_held() -> TestResult {
    let mut w = world()?;
    let trader = w.trader.key.insecure_clone();
    let open = open_claims_ix(&trader.pubkey(), &w.intent, HOUR, 0);
    w.env.send(&trader, &[open], &[])?;
    let holder = w.env.funded()?;
    let other = w.env.funded()?;
    let unboarded = w.announce(&other, wallet_blob(1));
    assert_eq!(
        w.send(&other, &unboarded).err(),
        Some(engine_error_at(0, EngineError::ClaimsMissing))
    );
    let claim = claim_job_ix(&holder.pubkey(), &w.intent, &trader.pubkey(), 60);
    w.env.send(&holder, &[claim], &[])?;
    let mut blocked = w.announce(&other, wallet_blob(2));
    blocked.board = Some(claims_pda(&w.intent));
    assert_eq!(
        w.send(&other, &blocked).err(),
        Some(engine_error_at(0, EngineError::ClaimHeld))
    );
    let mut held = w.announce(&holder, wallet_blob(3));
    held.board = Some(claims_pda(&w.intent));
    w.send(&holder, &held)?;
    let now = w.env.now();
    w.env.set_now(now + 61);
    let mut lapsed = w.announce(&other, wallet_blob(4));
    lapsed.board = Some(claims_pda(&w.intent));
    w.send(&other, &lapsed)?;
    assert_eq!((w.stored(&held)?.seq, w.stored(&lapsed)?.seq), (1, 2));
    Ok(())
}

#[test]
fn the_same_blob_announces_once_and_a_new_url_announces_again() -> TestResult {
    let mut w = world()?;
    let worker = w.env.funded()?;
    let first = w.announce(&worker, wallet_blob(1));
    w.send(&worker, &first)?;
    w.env.svm.expire_blockhash();
    assert!(w.send(&worker, &first).is_err());
    assert_eq!(w.book()?.next_seq, 2);
    let moved = w.announce(&worker, wallet_blob(2));
    w.send(&worker, &moved)?;
    assert_eq!(w.stored(&moved)?.seq, 2);
    Ok(())
}

#[test]
fn a_copied_announcement_under_another_wallet_never_blocks_the_worker() -> TestResult {
    let mut w = world()?;
    let worker = w.env.funded()?;
    let copier = w.env.funded()?;
    let honest = w.announce(&worker, wallet_blob(1));
    let copy = Announce {
        worker: copier.pubkey(),
        payer: copier.pubkey(),
        ..honest.clone()
    };
    w.send(&copier, &copy)?;
    w.send(&worker, &honest)?;
    assert_eq!((w.stored(&copy)?.seq, w.stored(&honest)?.seq), (1, 2));
    assert_eq!(w.stored(&honest)?.worker, worker.pubkey());
    Ok(())
}

#[test]
fn lamports_sent_ahead_to_the_book_or_an_announcement_never_block_it() -> TestResult {
    let mut w = world()?;
    let worker = w.env.funded()?;
    let a = w.announce(&worker, wallet_blob(1));
    w.env
        .svm
        .airdrop(&book_pda(&w.intent), 1_000_000)
        .map_err(|f| format!("{:?}", f.err))?;
    w.env
        .svm
        .airdrop(&a.address(), 1_000_000)
        .map_err(|f| format!("{:?}", f.err))?;
    w.send(&worker, &a)?;
    assert_eq!(w.book()?.next_seq, 2);
    assert_eq!(w.stored(&a)?.seq, 1);
    Ok(())
}

#[test]
fn the_announce_fee_goes_to_the_fee_recipient_and_is_required() -> TestResult {
    let mut w = world()?;
    let authority = w.env.authority.insecure_clone();
    let set = set_announce_fee_ix(&authority.pubkey(), 5_000);
    w.env.send(&authority, &[set], &[])?;
    assert_eq!(w.env.config()?.announce_fee, 5_000);
    let worker = w.env.funded()?;
    let unpaid = w.announce(&worker, wallet_blob(1));
    assert_eq!(
        w.send(&worker, &unpaid).err(),
        Some(engine_error_at(0, EngineError::AnnounceFeeMissing))
    );
    let recipient = w.env.fee_recipient;
    let before = w.env.lamports(&recipient);
    let mut paid = w.announce(&worker, wallet_blob(2));
    paid.fee_to = Some(recipient);
    w.send(&worker, &paid)?;
    assert_eq!(w.env.lamports(&recipient), before + 5_000);
    let stranger = w.env.funded()?;
    let refused = set_announce_fee_ix(&stranger.pubkey(), 1);
    assert_eq!(
        w.env.send(&stranger, &[refused], &[]).err(),
        Some(engine_error_at(0, EngineError::Unauthorized))
    );
    let over = set_announce_fee_ix(&authority.pubkey(), u32::MAX);
    assert_eq!(
        w.env.send(&authority, &[over], &[]).err(),
        Some(engine_error_at(0, EngineError::CreateFeeTooHigh))
    );
    Ok(())
}

#[test]
fn many_announcements_keep_one_contiguous_sequence() -> TestResult {
    let mut w = world()?;
    let spammer = w.env.funded()?;
    for fill in 0..200u8 {
        let a = w.announce(&spammer, wallet_blob(fill));
        w.send(&spammer, &a)?;
    }
    let worker = w.env.funded()?;
    let honest = w.announce(&worker, wallet_blob(201));
    w.send(&worker, &honest)?;
    assert_eq!(w.stored(&honest)?.seq, 201);
    assert_eq!((w.book()?.next_seq, w.book()?.live), (202, 201));
    Ok(())
}

#[test]
fn an_invite_list_admits_only_listed_workers_to_announce() -> TestResult {
    let mut w = world()?;
    let trader = w.trader.key.insecure_clone();
    let listed = w.env.funded()?;
    let outsider = w.env.funded()?;
    let open = open_claims_listed_ix(&trader.pubkey(), &w.intent, HOUR, 0, 1, &[listed.pubkey()]);
    w.env.send(&trader, &[open], &[])?;
    let mut refused = w.announce(&outsider, wallet_blob(1));
    refused.board = Some(claims_pda(&w.intent));
    refused.claim_list = Some(claim_list_pda(&w.intent));
    assert_eq!(
        w.send(&outsider, &refused).err(),
        Some(engine_error_at(0, EngineError::NotListed))
    );
    let mut bare = w.announce(&outsider, wallet_blob(2));
    bare.board = Some(claims_pda(&w.intent));
    assert_eq!(
        w.send(&outsider, &bare).err(),
        Some(engine_error_at(0, EngineError::ClaimListMissing))
    );
    let mut admitted = w.announce(&listed, wallet_blob(3));
    admitted.board = Some(claims_pda(&w.intent));
    admitted.claim_list = Some(claim_list_pda(&w.intent));
    w.send(&listed, &admitted)?;
    Ok(())
}
