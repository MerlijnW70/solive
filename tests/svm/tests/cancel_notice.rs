use intent_engine::errors::EngineError;
use intent_engine::events::{CancelRequested, ReviewArmed};
use intent_engine::state::{DeliveryBook, DELIVERY_BOOK_VERSION};
use litesvm::types::TransactionMetadata;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    book_pda, engine_error_at, events, load, ClaimWorld, ReleasePath, TestResult, FAIR_DAY,
    FAIR_EXPIRY, FAIR_HOLD, FAIR_STAKE, FAIR_TERMS,
};

const ROUTE: ReleasePath = ReleasePath::Attested;

fn ok(sent: Result<TransactionMetadata, TransactionError>) -> TestResult<TransactionMetadata> {
    sent.map_err(|e| format!("{e:?}").into())
}

fn unclaimed() -> TestResult<ClaimWorld> {
    ClaimWorld::expiring(ROUTE, FAIR_TERMS, FAIR_EXPIRY)
}

fn book(w: &ClaimWorld) -> TestResult<DeliveryBook> {
    load(&w.release.env.svm, &book_pda(&w.intent()))
}

#[test]
fn cancel_on_an_announced_escrow_needs_a_request_and_waits_the_notice() -> TestResult {
    let mut w = unclaimed()?;
    let worker = w.release.workers[0].insecure_clone();
    w.announce(&worker)?;
    assert_eq!(
        w.cancel(None).err(),
        Some(engine_error_at(0, EngineError::CancelNoticeRequired))
    );
    let asked = w.now();
    let meta = ok(w.request_cancel())?;
    let requested = events::<CancelRequested>(&meta);
    assert_eq!(
        requested.first().map(|e| (e.intent, e.owner, e.cancel_at)),
        Some((w.intent(), w.owner(), asked + FAIR_DAY))
    );
    assert_eq!(book(&w)?.cancel_at, asked + FAIR_DAY);
    assert_eq!(book(&w)?.version, DELIVERY_BOOK_VERSION);
    assert_eq!(
        w.request_cancel().err(),
        Some(engine_error_at(0, EngineError::CancelAlreadyRequested))
    );
    w.set_now(asked + FAIR_DAY - 1);
    assert_eq!(
        w.cancel(None).err(),
        Some(engine_error_at(0, EngineError::CancelNoticeRunning))
    );
    w.set_now(asked + FAIR_DAY);
    let vault = w.release.env.balance(&w.release.vault())?;
    let before = w.release.env.balance(&w.release.trader.input)?;
    ok(w.cancel(None))?;
    assert_eq!(
        w.release.env.balance(&w.release.trader.input)?,
        before + vault
    );
    assert_eq!(
        w.request_cancel().err(),
        Some(engine_error_at(0, EngineError::InvalidTransition))
    );
    Ok(())
}

#[test]
fn release_still_pays_during_the_notice() -> TestResult {
    let mut w = unclaimed()?;
    let worker = w.release.workers[0].insecure_clone();
    w.announce(&worker)?;
    ok(w.request_cancel())?;
    w.set_now(w.now() + FAIR_DAY - 1);
    let paid = w.release.env.balance(&w.release.atas[0])?;
    ok(w.release_to(ROUTE, None)?)?;
    assert!(w.release.env.balance(&w.release.atas[0])? > paid);
    w.set_now(w.now() + 1);
    assert_eq!(
        w.cancel(None).err(),
        Some(engine_error_at(0, EngineError::InvalidTransition))
    );
    Ok(())
}

#[test]
fn an_unclaimed_escrow_reports_unprotected_and_cancels_after_notice() -> TestResult {
    let mut w = unclaimed()?;
    let worker = w.release.workers[0].insecure_clone();
    let intent = w.intent();
    let attestor = w.release.attestor.pubkey();
    let (blob, _) = w.release.env.delivery_blob(&intent, &attestor)?;
    let a = svm_tests::Announce::new(worker.pubkey(), intent, attestor, blob);
    let meta = ok(w.release.env.send(&worker, &[a.ix()], &[]))?;
    assert!(events::<ReviewArmed>(&meta).is_empty());
    ok(w.request_cancel())?;
    w.set_now(w.now() + FAIR_DAY);
    ok(w.cancel(None))?;
    Ok(())
}

#[test]
fn cancel_before_any_announcement_stays_immediate() -> TestResult {
    let mut w = unclaimed()?;
    ok(w.open_review(FAIR_HOLD, FAIR_STAKE, 86_400, FAIR_STAKE))?;
    let holder = w.release.workers[0].insecure_clone();
    ok(w.claim(&holder, FAIR_HOLD))?;
    assert!(w.request_cancel().is_err());
    let before = w.lamports(&holder.pubkey());
    ok(w.cancel(Some(&holder.pubkey())))?;
    assert_eq!(w.lamports(&holder.pubkey()), before + FAIR_STAKE);
    Ok(())
}

#[test]
fn junk_on_unclaimed_escrow_delays_cancel_by_notice_once() -> TestResult {
    let mut w = unclaimed()?;
    let junk = w.funded()?;
    w.announce(&junk)?;
    ok(w.request_cancel())?;
    let at = book(&w)?.cancel_at;
    for step in [1, 2, 3] {
        w.set_now(at - 10 + step);
        let more = w.funded()?;
        w.announce(&more)?;
        assert_eq!(book(&w)?.cancel_at, at);
    }
    w.set_now(at);
    ok(w.cancel(None))?;
    Ok(())
}

#[test]
fn a_version_one_book_counts_as_no_request_and_migrates_to_take_one() -> TestResult {
    let mut w = unclaimed()?;
    let worker = w.release.workers[0].insecure_clone();
    let d = w.announce(&worker)?;
    let key = book_pda(&w.intent());
    let mut account = w.release.env.svm.get_account(&key).ok_or("no book")?;
    account.data.truncate(96);
    let version_at = 8 + core::mem::offset_of!(DeliveryBook, version);
    *account.data.get_mut(version_at).ok_or("short")? = 1;
    account.lamports = w.release.env.svm.minimum_balance_for_rent_exemption(96);
    w.release.env.svm.set_account(key, account)?;
    assert_eq!(
        w.cancel(None).err(),
        Some(engine_error_at(0, EngineError::CancelNoticeRequired))
    );
    assert!(w.request_cancel().is_err());
    let payer = w.payer.insecure_clone();
    let migrate = svm_tests::migrate_ix(&payer.pubkey(), &key, None);
    ok(w.release.env.send(&payer, &[migrate], &[]))?;
    assert_eq!(
        (book(&w)?.version, book(&w)?.cancel_at, book(&w)?.live),
        (DELIVERY_BOOK_VERSION, 0, 1)
    );
    ok(w.request_cancel())?;
    w.set_now(w.now().saturating_add(FAIR_DAY));
    ok(w.cancel(None))?;
    let close = svm_tests::close_announcement_ix(
        &worker.pubkey(),
        &d.announcement,
        &w.intent(),
        &worker.pubkey(),
    );
    ok(w.release.env.send(&worker, &[close], &[]))?;
    assert_eq!(book(&w)?.live, 0);
    Ok(())
}

fn announced_world() -> TestResult<ClaimWorld> {
    let mut w = unclaimed()?;
    let worker = w.release.workers[0].insecure_clone();
    w.announce(&worker)?;
    Ok(w)
}

#[test]
fn a_cancel_request_needs_the_owner_signature() -> TestResult {
    let mut w = announced_world()?;
    let mut ix = svm_tests::request_cancel_ix(&w.owner(), &w.intent());
    let owner = ix.accounts.first_mut().ok_or("no owner")?;
    owner.is_signer = false;
    assert_eq!(
        w.send(&[ix], &[]).err(),
        Some(svm_tests::anchor_error_at(
            0,
            anchor_lang::error::ErrorCode::AccountNotSigner
        ))
    );
    assert_eq!(book(&w)?.cancel_at, 0);
    Ok(())
}

#[test]
fn a_cancel_request_by_another_wallet_is_refused() -> TestResult {
    let mut w = announced_world()?;
    let stranger = w.funded()?;
    let ix = svm_tests::request_cancel_ix(&stranger.pubkey(), &w.intent());
    assert_eq!(
        w.send(&[ix], &[&stranger]).err(),
        Some(engine_error_at(0, EngineError::Unauthorized))
    );
    assert_eq!(book(&w)?.cancel_at, 0);
    Ok(())
}

#[test]
fn a_cancel_request_against_a_book_another_program_owns_is_refused() -> TestResult {
    let mut w = announced_world()?;
    let key = book_pda(&w.intent());
    let mut account = w.release.env.svm.get_account(&key).ok_or("no book")?;
    account.owner = anchor_spl::token::ID;
    w.release.env.svm.set_account(key, account)?;
    assert_eq!(
        w.request_cancel().err(),
        Some(svm_tests::anchor_error_at(
            0,
            anchor_lang::error::ErrorCode::AccountOwnedByWrongProgram
        ))
    );
    Ok(())
}

#[test]
fn a_cancel_request_with_the_intent_in_place_of_the_book_is_refused() -> TestResult {
    let mut w = announced_world()?;
    let owner = w.release.trader.key.insecure_clone();
    let mut ix = svm_tests::request_cancel_ix(&owner.pubkey(), &w.intent());
    let book = ix.accounts.get_mut(2).ok_or("no book")?;
    book.pubkey = w.intent();
    assert_eq!(
        w.send(&[ix], &[&owner]).err(),
        Some(svm_tests::anchor_error_at(
            0,
            anchor_lang::error::ErrorCode::AccountDiscriminatorMismatch
        ))
    );
    Ok(())
}
