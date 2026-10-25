use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use intent_core::delivery::REFUTE_WINDOW_SECS;
use intent_core::kinds::{attested_result, Kind};
use intent_engine::errors::EngineError;
use intent_engine::state::{Announcement, DeliveryBook, Refutation};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    anchor_error_at, attestation_proof_message, book_pda, close_announcement_ix,
    close_delivery_book_ix, ed25519_ix, engine_error_at, intent_pda, load, refutation_pda,
    refute_ix, swap_spec, Announce, Delivery, Env, IntentSpec, Market, Solver, TestResult, Trader,
    DOMAIN, SALT,
};

const FUNDED: u64 = 1_000;
const ESCROW: u64 = 400;
const SPEC: [u8; 32] = [0x3d; 32];

struct World {
    env: Env,
    market: Market,
    trader: Trader,
    judge: Keypair,
    early: Solver,
    late: Solver,
    fee_to: Pubkey,
    intent: Pubkey,
}

fn copy(s: &Solver) -> Solver {
    Solver {
        key: s.key.insecure_clone(),
        output: s.output,
        input: s.input,
    }
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
    let early = env.solver(&market, 0)?;
    let late = env.solver(&market, 0)?;
    let fee_to = env.fee_account(&market)?;
    let intent = intent_pda(&trader.key.pubkey(), 0);
    Ok(World {
        env,
        market,
        trader,
        judge,
        early,
        late,
        fee_to,
        intent,
    })
}

impl World {
    fn announce(&mut self, who: &Solver) -> TestResult<Delivery> {
        let key = who.key.insecure_clone();
        self.env.announce_for(&key, &self.intent)
    }

    fn try_announce(&mut self, by: &Keypair) -> TestResult<Option<TransactionError>> {
        let blob = self
            .env
            .delivery_blob(&self.intent, &self.judge.pubkey())?
            .0;
        let a = Announce::new(by.pubkey(), self.intent, self.judge.pubkey(), blob);
        let signer = by.insecure_clone();
        Ok(self.env.send(&signer, &[a.ix()], &[]).err())
    }

    fn pay(&mut self, to: &Solver, d: &Delivery) -> TestResult<i64> {
        self.env.announcement = Some(d.announcement);
        self.env.opening = d.opening;
        let message = attestation_proof_message(
            DOMAIN,
            &self.judge.pubkey(),
            &self.intent,
            &to.input,
            ESCROW,
            1,
            SPEC,
            d,
        );
        let owner = self.trader.key.pubkey();
        let fill = self.env.fill_attested_ix(
            &to.key.pubkey(),
            &owner,
            &self.market,
            0,
            &to.input,
            Some(&self.fee_to),
            1,
        );
        let key = to.key.insecure_clone();
        self.env
            .send(&key, &[ed25519_ix(&self.judge, &message), fill], &[])?;
        Ok(self.env.now())
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

    fn live(&self) -> TestResult<u64> {
        let book: DeliveryBook = load(&self.env.svm, &book_pda(&self.intent))?;
        Ok(book.live)
    }

    fn exists(&self, address: &Pubkey) -> bool {
        self.env
            .svm
            .get_account(address)
            .is_some_and(|a| !a.data.is_empty())
    }
}

#[test]
fn one_transaction_cannot_close_the_same_announcement_twice() -> TestResult {
    let mut w = world()?;
    let early = copy(&w.early);
    let late = copy(&w.late);
    let kept = w.announce(&late)?;
    let d = w.announce(&early)?;
    w.cancel()?;
    let worker = early.key.insecure_clone();
    let ix = close_announcement_ix(
        &worker.pubkey(),
        &d.announcement,
        &w.intent,
        &worker.pubkey(),
    );
    let before = w.env.lamports(&worker.pubkey());
    assert_eq!(
        w.env.send(&worker, &[ix.clone(), ix.clone()], &[]).err(),
        Some(anchor_error_at(1, ErrorCode::AccountOwnedByWrongProgram))
    );
    assert!(w.exists(&d.announcement));
    assert_eq!(w.live()?, 2);
    assert_eq!(w.env.lamports(&worker.pubkey()), before - 5_000);
    w.env.send(&worker, &[ix], &[])?;
    assert!(!w.exists(&d.announcement));
    assert_eq!(w.live()?, 1);
    assert!(w.exists(&kept.announcement));
    Ok(())
}

#[test]
fn a_third_party_cannot_close_an_earlier_announcement_while_it_can_still_refute() -> TestResult {
    let mut w = world()?;
    let (early, late) = (copy(&w.early), copy(&w.late));
    let first = w.announce(&early)?;
    let second = w.announce(&late)?;
    let paid_at = w.pay(&late, &second)?;
    let crank = w.env.funded()?;
    let earlier: Announcement = load(&w.env.svm, &first.announcement)?;
    w.env.set_now(paid_at + REFUTE_WINDOW_SECS - 1);
    assert_eq!(
        w.close(&crank, &first, &early.key.pubkey()),
        Some(engine_error_at(0, EngineError::AnnouncementRetained))
    );
    assert_eq!(
        w.close(&crank, &second, &late.key.pubkey()),
        Some(engine_error_at(0, EngineError::AnnouncementRetained))
    );
    let ix = refute_ix(
        &early.key.pubkey(),
        &second.announcement,
        &first.announcement,
        SALT,
        None,
    );
    w.env.send(&early.key, &[ix], &[])?;
    let stored: Refutation = load(&w.env.svm, &refutation_pda(&first.announcement))?;
    assert_eq!(
        (stored.paid_announcement, stored.earlier_announcement),
        (second.announcement, first.announcement)
    );
    assert_eq!(stored.refuted_at, paid_at + REFUTE_WINDOW_SECS - 1);
    assert!(earlier.expires_at > paid_at);
    w.env.set_now(paid_at + REFUTE_WINDOW_SECS);
    assert_eq!(
        w.close(&crank, &first, &early.key.pubkey()),
        Some(engine_error_at(0, EngineError::AnnouncementRetained))
    );
    assert_eq!(w.close(&crank, &second, &late.key.pubkey()), None);
    w.env.set_now(earlier.expires_at + REFUTE_WINDOW_SECS - 1);
    assert_eq!(
        w.close(&crank, &first, &early.key.pubkey()),
        Some(engine_error_at(0, EngineError::AnnouncementRetained))
    );
    w.env.set_now(earlier.expires_at + REFUTE_WINDOW_SECS);
    assert_eq!(w.close(&crank, &first, &early.key.pubkey()), None);
    assert!(!w.exists(&first.announcement));
    Ok(())
}

#[test]
fn nobody_announces_again_after_the_delivery_book_closes() -> TestResult {
    let mut w = world()?;
    let early = copy(&w.early);
    let d = w.announce(&early)?;
    let expires_at = w.env.intent(&w.trader.key.pubkey(), 0)?.expires_at;
    w.env.set_now(expires_at);
    let worker = early.key.insecure_clone();
    assert_eq!(w.close(&worker, &d, &worker.pubkey()), None);
    let book: DeliveryBook = load(&w.env.svm, &book_pda(&w.intent))?;
    let crank = w.env.funded()?;
    let close = close_delivery_book_ix(&crank.pubkey(), &w.intent, &book.payer);
    w.env.send(&crank, &[close], &[])?;
    assert!(!w.exists(&book_pda(&w.intent)));
    let stranger = w.env.funded()?;
    for by in [&worker, &stranger] {
        assert_eq!(
            w.try_announce(by)?,
            Some(engine_error_at(0, EngineError::InvalidTransition))
        );
    }
    assert!(!w.exists(&book_pda(&w.intent)));
    Ok(())
}
