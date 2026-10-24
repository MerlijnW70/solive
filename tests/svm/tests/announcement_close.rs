use anchor_lang::prelude::Pubkey;
use intent_core::delivery::REFUTE_WINDOW_SECS;
use intent_core::kinds::{attested_result, Kind};
use intent_engine::errors::EngineError;
use intent_engine::events::{AnnouncementClosed, DeliveryBookClosed};
use intent_engine::state::DeliveryBook;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    attestation_proof_message, book_pda, close_announcement_ix, close_delivery_book_ix, ed25519_ix,
    engine_error_at, events, intent_pda, load, swap_spec, Delivery, Env, IntentSpec, Market,
    Solver, TestResult, Trader, DOMAIN,
};

const FUNDED: u64 = 1_000;
const ESCROW: u64 = 400;
const SPEC: [u8; 32] = [0x7c; 32];

struct World {
    env: Env,
    market: Market,
    trader: Trader,
    judge: Keypair,
    worker: Solver,
    fee_to: Pubkey,
    intent: Pubkey,
}

fn world() -> TestResult<World> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(anchor_spl::token::ID, &[], anchor_spl::token::ID, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let judge = env.funded()?;
    let spec = IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: ESCROW,
            min_result: 1,
            max_result: 1,
            attestor: judge.pubkey().to_bytes(),
            spec_hash: SPEC,
            judge_fee: 0,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ..swap_spec(0, ESCROW)?
    };
    env.create_intent(&trader, &market, &spec)?;
    let worker = env.solver(&market, 0)?;
    let fee_to = env.fee_account(&market)?;
    let intent = intent_pda(&trader.key.pubkey(), 0);
    Ok(World {
        env,
        market,
        trader,
        judge,
        worker,
        fee_to,
        intent,
    })
}

impl World {
    fn announce(&mut self) -> TestResult<Delivery> {
        let key = self.worker.key.insecure_clone();
        self.env.announce_for(&key, &self.intent)
    }

    fn close(&mut self, by: &Keypair, d: &Delivery, rent_to: &Pubkey) -> Option<TransactionError> {
        let ix = close_announcement_ix(&by.pubkey(), &d.announcement, &self.intent, rent_to);
        let signer = by.insecure_clone();
        self.env.send(&signer, &[ix], &[]).err()
    }

    fn cancel(&mut self) -> TestResult {
        let trader = self.trader.key.insecure_clone();
        let ix = self
            .env
            .cancel_ix(&trader.pubkey(), &self.market, 0, &self.trader.input);
        self.env.send(&trader, &[ix], &[])?;
        Ok(())
    }

    fn expires_at(&self) -> TestResult<i64> {
        Ok(self.env.intent(&self.trader.key.pubkey(), 0)?.expires_at)
    }
}

#[test]
fn a_worker_takes_back_an_unpaid_announcement_once_its_escrow_is_cancelled() -> TestResult {
    let mut w = world()?;
    let d = w.announce()?;
    let worker = w.worker.key.insecure_clone();
    assert_eq!(
        w.close(&worker, &d, &worker.pubkey()),
        Some(engine_error_at(0, EngineError::AnnouncementOpen))
    );
    w.cancel()?;
    let before = w.env.lamports(&worker.pubkey());
    let ix = close_announcement_ix(
        &worker.pubkey(),
        &d.announcement,
        &w.intent,
        &worker.pubkey(),
    );
    let meta = w.env.send(&worker, &[ix], &[])?;
    let closed = events::<AnnouncementClosed>(&meta);
    let lamports = closed.first().map(|e| e.lamports).ok_or("no event")?;
    assert!(lamports > 0);
    assert_eq!(w.env.lamports(&worker.pubkey()), before + lamports - 5_000);
    assert!(w
        .env
        .svm
        .get_account(&d.announcement)
        .is_none_or(|a| a.data.is_empty()));
    let book: DeliveryBook = load(&w.env.svm, &book_pda(&w.intent))?;
    assert_eq!((book.live, book.next_seq), (0, 2));
    Ok(())
}

#[test]
fn a_worker_takes_back_an_unpaid_announcement_after_expiry_without_a_crank() -> TestResult {
    let mut w = world()?;
    let d = w.announce()?;
    let worker = w.worker.key.insecure_clone();
    let expires_at = w.expires_at()?;
    w.env.set_now(expires_at);
    assert_eq!(w.close(&worker, &d, &worker.pubkey()), None);
    Ok(())
}

#[test]
fn others_close_an_unpaid_announcement_only_after_the_refute_window_and_only_to_its_payer(
) -> TestResult {
    let mut w = world()?;
    let d = w.announce()?;
    let worker = w.worker.key.insecure_clone();
    let crank = w.env.funded()?;
    w.cancel()?;
    let expires_at = w.expires_at()?;
    w.env.set_now(expires_at + REFUTE_WINDOW_SECS - 1);
    assert_eq!(
        w.close(&crank, &d, &worker.pubkey()),
        Some(engine_error_at(0, EngineError::AnnouncementRetained))
    );
    w.env.set_now(expires_at + REFUTE_WINDOW_SECS);
    assert_eq!(
        w.close(&crank, &d, &crank.pubkey()),
        Some(engine_error_at(0, EngineError::RentRecipientMismatch))
    );
    let before = w.env.lamports(&worker.pubkey());
    assert_eq!(w.close(&crank, &d, &worker.pubkey()), None);
    assert!(w.env.lamports(&worker.pubkey()) > before);
    Ok(())
}

#[test]
fn a_relayer_that_paid_the_rent_cannot_close_the_announcement_early() -> TestResult {
    let mut w = world()?;
    let worker = w.worker.key.insecure_clone();
    let relayer = w.env.funded()?;
    let blob = w.env.delivery_blob(&w.intent, &w.judge.pubkey())?.0;
    let mut a = svm_tests::Announce::new(worker.pubkey(), w.intent, w.judge.pubkey(), blob);
    a.payer = relayer.pubkey();
    w.env.send(&relayer, &[a.ix()], &[&worker])?;
    let d = Delivery {
        announcement: a.address(),
        seq: 1,
        opening: intent_engine::Opening::default(),
    };
    w.cancel()?;
    assert_eq!(
        w.close(&relayer, &d, &relayer.pubkey()),
        Some(engine_error_at(0, EngineError::AnnouncementRetained))
    );
    assert_eq!(
        w.close(&worker, &d, &worker.pubkey()),
        Some(engine_error_at(0, EngineError::RentRecipientMismatch))
    );
    assert_eq!(w.close(&worker, &d, &relayer.pubkey()), None);
    Ok(())
}

#[test]
fn a_paid_announcement_stays_through_the_refute_window() -> TestResult {
    let mut w = world()?;
    let d = w.announce()?;
    let worker = w.worker.key.insecure_clone();
    let message = attestation_proof_message(
        DOMAIN,
        &w.judge.pubkey(),
        &w.intent,
        &w.worker.input,
        ESCROW,
        1,
        SPEC,
        &d,
    );
    let owner = w.trader.key.pubkey();
    let fill = w.env.fill_attested_ix(
        &worker.pubkey(),
        &owner,
        &w.market,
        0,
        &w.worker.input,
        Some(&w.fee_to),
        1,
    );
    w.env
        .send(&worker, &[ed25519_ix(&w.judge, &message), fill], &[])?;
    let paid_at = w.env.now();
    w.env.set_now(paid_at + REFUTE_WINDOW_SECS - 1);
    assert_eq!(
        w.close(&worker, &d, &worker.pubkey()),
        Some(engine_error_at(0, EngineError::AnnouncementRetained))
    );
    w.env.set_now(paid_at + REFUTE_WINDOW_SECS);
    assert_eq!(w.close(&worker, &d, &worker.pubkey()), None);
    Ok(())
}

#[test]
fn the_delivery_book_closes_only_when_empty_and_its_escrow_is_not_open() -> TestResult {
    let mut w = world()?;
    let d = w.announce()?;
    let worker = w.worker.key.insecure_clone();
    let crank = w.env.funded()?;
    let book: DeliveryBook = load(&w.env.svm, &book_pda(&w.intent))?;
    let close_book = |w: &World| close_delivery_book_ix(&crank.pubkey(), &w.intent, &book.payer);
    let open = close_book(&w);
    assert_eq!(
        w.env.send(&crank, &[open], &[]).err(),
        Some(engine_error_at(0, EngineError::DeliveryBookOpen))
    );
    w.cancel()?;
    let live = close_book(&w);
    assert_eq!(
        w.env.send(&crank, &[live], &[]).err(),
        Some(engine_error_at(0, EngineError::DeliveryBookLive))
    );
    assert_eq!(w.close(&worker, &d, &worker.pubkey()), None);
    let before = w.env.lamports(&book.payer);
    let meta = w.env.send(&crank, &[close_book(&w)], &[])?;
    let closed = events::<DeliveryBookClosed>(&meta);
    assert_eq!(closed.first().map(|e| e.next_seq), Some(2));
    assert!(w.env.lamports(&book.payer) > before);
    assert!(w
        .env
        .svm
        .get_account(&book_pda(&w.intent))
        .is_none_or(|a| a.data.is_empty()));
    Ok(())
}
