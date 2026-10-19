use anchor_lang::prelude::Pubkey;
use intent_core::kinds::{attested_result, Kind};
use intent_engine::errors::EngineError;
use intent_engine::events::{JobClaimed, LineLeft, StakeMoved, StoodBy, STAKE_TO_OWNER};
use intent_engine::state::{ClaimBoard, Standby};
use litesvm::types::TransactionMetadata;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    advance_ix, claim_job_ix, claims_pda, drop_claim_ix, drop_claim_line_ix, engine_error_at,
    events, intent_pda, leave_ix, load, open_claims_ix, settle_claims_ix, stand_by_ix, standby_pda,
    swap_spec, Env, IntentSpec, Market, TestResult, Trader,
};

const FUNDED: u64 = 1_000;
const ESCROW: u64 = 400;
const SPEC: [u8; 32] = [0x5a; 32];
const STAKE: u64 = 50_000_000;
const HOUR: u32 = 3_600;

struct World {
    env: Env,
    market: Market,
    trader: Trader,
    payer: Keypair,
}

fn world() -> TestResult<World> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(anchor_spl::token::ID, &[], anchor_spl::token::ID, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let spec = IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: ESCROW,
            min_result: 1,
            max_result: 1,
            attestor: Keypair::new().pubkey().to_bytes(),
            spec_hash: SPEC,
            judge_fee: 0,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ..swap_spec(0, ESCROW)?
    };
    env.create_intent(&trader, &market, &spec)?;
    let payer = env.funded()?;
    let mut w = World {
        env,
        market,
        trader,
        payer,
    };
    let ix = open_claims_ix(&w.owner(), &w.intent(), HOUR, STAKE);
    let owner = w.trader.key.insecure_clone();
    w.env.send(&owner, &[ix], &[])?;
    Ok(w)
}

impl World {
    fn owner(&self) -> Pubkey {
        self.trader.key.pubkey()
    }

    fn intent(&self) -> Pubkey {
        intent_pda(&self.owner(), 0)
    }

    fn entry(&self, seq: u32) -> Pubkey {
        standby_pda(&self.intent(), seq)
    }

    fn run(
        &mut self,
        ixs: &[solana_instruction::Instruction],
        signers: &[&Keypair],
    ) -> Result<TransactionMetadata, TransactionError> {
        let payer = self.payer.insecure_clone();
        self.env.send(&payer, ixs, signers)
    }

    fn claim(&mut self, who: &Keypair, secs: u32) -> Result<TransactionMetadata, TransactionError> {
        let ix = claim_job_ix(&who.pubkey(), &self.intent(), &self.owner(), secs);
        self.run(&[ix], &[who])
    }

    fn stand_by(
        &mut self,
        who: &Keypair,
        seq: u32,
        secs: u32,
    ) -> Result<TransactionMetadata, TransactionError> {
        let ix = stand_by_ix(&who.pubkey(), &self.intent(), seq, secs);
        self.run(&[ix], &[who])
    }

    fn drop_to(
        &mut self,
        who: &Keypair,
        seqs: &[u32],
        next: Option<&Pubkey>,
    ) -> Result<TransactionMetadata, TransactionError> {
        let entries: Vec<Pubkey> = seqs.iter().map(|s| self.entry(*s)).collect();
        let ix = drop_claim_line_ix(&who.pubkey(), &self.intent(), &entries, next);
        self.run(&[ix], &[who])
    }

    fn advance(
        &mut self,
        seqs: &[u32],
        next: Option<&Pubkey>,
    ) -> Result<TransactionMetadata, TransactionError> {
        let entries: Vec<Pubkey> = seqs.iter().map(|s| self.entry(*s)).collect();
        let ix = advance_ix(&self.intent(), &self.owner(), &entries, next);
        self.run(&[ix], &[])
    }

    fn leave(
        &mut self,
        caller: &Keypair,
        seq: u32,
        worker: &Pubkey,
    ) -> Result<TransactionMetadata, TransactionError> {
        let ix = leave_ix(&caller.pubkey(), &self.intent(), seq, worker);
        self.run(&[ix], &[caller])
    }

    fn cancel_paying(
        &mut self,
        stake_to: &Pubkey,
    ) -> Result<TransactionMetadata, TransactionError> {
        self.env.claims = Some(claims_pda(&self.intent()));
        self.env.stake_to = Some(*stake_to);
        let cancel = self
            .env
            .cancel_ix(&self.owner(), &self.market, 0, &self.trader.input);
        self.env.claims = None;
        self.env.stake_to = None;
        let trader = self.trader.key.insecure_clone();
        self.env.send(&trader, &[cancel], &[])
    }

    fn board(&self) -> TestResult<ClaimBoard> {
        load(&self.env.svm, &claims_pda(&self.intent()))
    }

    fn rent(&self) -> u64 {
        self.env
            .svm
            .minimum_balance_for_rent_exemption(Standby::SPACE)
    }

    fn lapse(&mut self, secs: u32) {
        let now = self.env.now();
        self.env.set_now(now.saturating_add(i64::from(secs)));
    }

    fn workers<const N: usize>(&mut self) -> TestResult<[Keypair; N]> {
        let keys = (0..N)
            .map(|_| self.env.funded())
            .collect::<TestResult<Vec<Keypair>>>()?;
        <[Keypair; N]>::try_from(keys).map_err(|_| "keys".into())
    }
}

fn claimed(meta: &TransactionMetadata) -> Vec<(Pubkey, i64, u64)> {
    events::<JobClaimed>(meta)
        .into_iter()
        .map(|e| (e.worker, e.until, e.stake))
        .collect()
}

#[test]
fn the_two_wallet_renewal_works_only_while_nobody_waits() -> TestResult {
    let mut w = world()?;
    let [first, second, waiter] = w.workers::<3>()?;
    let intent = w.intent();
    let owner = w.owner();
    w.claim(&first, 600)?;
    let renew = [
        drop_claim_ix(&first.pubkey(), &intent),
        claim_job_ix(&second.pubkey(), &intent, &owner, 600),
    ];
    w.run(&renew, &[&first, &second])?;
    assert_eq!(
        w.board()?.worker,
        second.pubkey(),
        "with nobody waiting, a second wallet renews the hold"
    );
    w.stand_by(&waiter, 0, 600)?;
    let renew_back = [
        drop_claim_ix(&second.pubkey(), &intent),
        claim_job_ix(&first.pubkey(), &intent, &owner, HOUR),
    ];
    assert_eq!(
        w.run(&renew_back, &[&first, &second]).err(),
        Some(engine_error_at(0, EngineError::LineEntryMismatch)),
        "a drop must hand the job to the line"
    );
    let handed = [
        drop_claim_line_ix(
            &second.pubkey(),
            &intent,
            &[w.entry(0)],
            Some(&waiter.pubkey()),
        ),
        claim_job_ix(&first.pubkey(), &intent, &owner, HOUR),
    ];
    assert_eq!(
        w.run(&handed, &[&first, &second]).err(),
        Some(engine_error_at(1, EngineError::ClaimHeld)),
        "the waiter, not the dropper's other wallet, takes the job"
    );
    w.stand_by(&first, 1, 600)?;
    w.lapse(600);
    assert_eq!(
        w.claim(&second, 60).err(),
        Some(engine_error_at(0, EngineError::LineWaiting)),
        "a lapsed job is not claimed past the line"
    );
    Ok(())
}

#[test]
fn the_line_serves_waiters_in_order_and_locks_their_stake_until_then() -> TestResult {
    let mut w = world()?;
    let [holder, a, b, c] = &w.workers::<4>()?;
    assert_eq!(
        w.stand_by(a, 0, 600).err(),
        Some(engine_error_at(0, EngineError::JobNotHeld)),
        "a free job is claimed, not waited for"
    );
    w.claim(holder, 600)?;
    assert_eq!(
        w.stand_by(a, 0, HOUR + 1).err(),
        Some(engine_error_at(0, EngineError::ClaimTerms))
    );
    assert_eq!(
        w.stand_by(a, 1, 600).err(),
        Some(engine_error_at(0, EngineError::LineEntryMismatch)),
        "an entry sits only at the line's tail"
    );
    let rent = w.rent();
    let before = w.env.lamports(&a.pubkey());
    let meta = w.stand_by(a, 0, 600)?;
    assert_eq!(w.env.lamports(&a.pubkey()), before - STAKE - rent);
    assert_eq!(w.env.lamports(&w.entry(0)), STAKE + rent);
    let stood: Vec<_> = events::<StoodBy>(&meta)
        .into_iter()
        .map(|e| (e.worker, e.seq, e.secs, e.stake))
        .collect();
    assert_eq!(stood, [(a.pubkey(), 0, 600, STAKE)]);
    w.stand_by(b, 1, 900)?;
    w.stand_by(c, 2, 1_200)?;
    let board = w.board()?;
    assert_eq!((board.head, board.tail), (0, 3));
    assert_eq!(
        w.drop_to(holder, &[1], Some(&b.pubkey())).err(),
        Some(engine_error_at(0, EngineError::LineEntryMismatch)),
        "nobody jumps the line"
    );
    assert_eq!(
        w.drop_to(holder, &[0], Some(&b.pubkey())).err(),
        Some(engine_error_at(0, EngineError::StakeAccountMismatch))
    );
    for (seq, (next, secs)) in [(a, 600), (b, 900), (c, 1_200)].into_iter().enumerate() {
        let current = w.board()?.worker;
        let dropper = [holder, a, b]
            .into_iter()
            .find(|k| k.pubkey() == current)
            .ok_or("holder")?;
        let board_before = w.env.lamports(&claims_pda(&w.intent()));
        let next_before = w.env.lamports(&next.pubkey());
        let seq = u32::try_from(seq)?;
        let meta = w.drop_to(dropper, &[seq], Some(&next.pubkey()))?;
        let now = w.env.now();
        assert_eq!(
            claimed(&meta),
            [(next.pubkey(), now + i64::from(secs), STAKE)]
        );
        let board = w.board()?;
        assert_eq!(
            (board.worker, board.held, board.head, board.tail),
            (next.pubkey(), STAKE, seq + 1, 3)
        );
        assert_eq!(w.env.lamports(&next.pubkey()), next_before + rent);
        assert_eq!(
            w.env.lamports(&claims_pda(&w.intent())),
            board_before,
            "the dropper's stake leaves and the waiter's stake arrives"
        );
        assert!(!w.env.exists(&w.entry(seq)));
    }
    w.lapse(1_200);
    w.claim(holder, 60)?;
    Ok(())
}

#[test]
fn a_lapsed_holder_is_advanced_past_with_its_stake_forfeited_to_the_owner() -> TestResult {
    let mut w = world()?;
    let [holder, waiter] = &w.workers::<2>()?;
    assert_eq!(
        w.advance(&[0], None).err(),
        Some(engine_error_at(0, EngineError::LineEmpty))
    );
    w.claim(holder, 60)?;
    w.stand_by(waiter, 0, 600)?;
    assert_eq!(
        w.advance(&[0], Some(&waiter.pubkey())).err(),
        Some(engine_error_at(0, EngineError::ClaimHeld)),
        "a holder within its term is not advanced past"
    );
    w.lapse(60);
    assert_eq!(
        w.advance(&[], Some(&waiter.pubkey())).err(),
        Some(engine_error_at(0, EngineError::LineEntryMismatch))
    );
    let owner = w.owner();
    let before = w.env.lamports(&owner);
    let meta = w.advance(&[0], Some(&waiter.pubkey()))?;
    assert_eq!(w.env.lamports(&owner), before + STAKE);
    let moved: Vec<_> = events::<StakeMoved>(&meta)
        .into_iter()
        .map(|e| (e.worker, e.to, e.amount, e.role))
        .collect();
    assert_eq!(moved, [(holder.pubkey(), owner, STAKE, STAKE_TO_OWNER)]);
    let now = w.env.now();
    assert_eq!(claimed(&meta), [(waiter.pubkey(), now + 600, STAKE)]);
    let board = w.board()?;
    assert_eq!(
        (board.worker, board.held, board.head),
        (waiter.pubkey(), STAKE, 1)
    );
    Ok(())
}

#[test]
fn entries_whose_accounts_are_gone_are_skipped() -> TestResult {
    let mut w = world()?;
    let [holder, a, b, c, d] = &w.workers::<5>()?;
    w.claim(holder, 600)?;
    w.stand_by(a, 0, 600)?;
    w.stand_by(b, 1, 600)?;
    w.stand_by(c, 2, 600)?;
    assert_eq!(
        w.leave(b, 0, &a.pubkey()).err(),
        Some(engine_error_at(0, EngineError::Unauthorized)),
        "only the waiter leaves while the escrow is open"
    );
    let rent = w.rent();
    let before = w.env.lamports(&a.pubkey());
    let meta = w.leave(a, 0, &a.pubkey())?;
    assert_eq!(w.env.lamports(&a.pubkey()), before + STAKE + rent);
    let left: Vec<_> = events::<LineLeft>(&meta)
        .into_iter()
        .map(|e| (e.worker, e.seq, e.refunded))
        .collect();
    assert_eq!(left, [(a.pubkey(), 0, STAKE + rent)]);
    w.leave(b, 1, &b.pubkey())?;
    let meta = w.drop_to(holder, &[0, 1, 2], Some(&c.pubkey()))?;
    assert_eq!(claimed(&meta).len(), 1);
    let board = w.board()?;
    assert_eq!((board.worker, board.head, board.tail), (c.pubkey(), 3, 3));
    w.stand_by(d, 3, 600)?;
    w.leave(d, 3, &d.pubkey())?;
    let meta = w.drop_to(c, &[3], None)?;
    assert!(claimed(&meta).is_empty());
    let board = w.board()?;
    assert_eq!(
        (board.worker, board.head, board.tail, board.dropped_by),
        (Pubkey::default(), 4, 4, c.pubkey())
    );
    assert_eq!(
        w.claim(c, 60).err(),
        Some(engine_error_at(0, EngineError::ClaimCooldown)),
        "the cooldown still holds once the line is gone"
    );
    w.claim(holder, 60)?;
    Ok(())
}

#[test]
fn a_hole_left_past_a_drop_is_advanced_over() -> TestResult {
    let mut w = world()?;
    let [holder, a, b] = &w.workers::<3>()?;
    w.claim(holder, 600)?;
    w.stand_by(a, 0, 600)?;
    w.stand_by(b, 1, 600)?;
    w.leave(a, 0, &a.pubkey())?;
    w.drop_to(holder, &[0], None)?;
    let board = w.board()?;
    assert_eq!(
        (board.worker, board.head, board.tail),
        (Pubkey::default(), 1, 2)
    );
    assert_eq!(
        w.claim(a, 60).err(),
        Some(engine_error_at(0, EngineError::LineWaiting))
    );
    w.advance(&[1], Some(&b.pubkey()))?;
    assert_eq!(w.board()?.worker, b.pubkey());
    Ok(())
}

#[test]
fn a_prefunded_entry_address_does_not_block_the_line() -> TestResult {
    let mut w = world()?;
    let [holder, waiter] = &w.workers::<2>()?;
    w.claim(holder, 600)?;
    let grief =
        solana_system_interface::instruction::transfer(&w.payer.pubkey(), &w.entry(0), 1_000_000);
    w.run(&[grief], &[])?;
    w.stand_by(waiter, 0, 600)?;
    let entry: Standby = load(&w.env.svm, &w.entry(0))?;
    assert_eq!(
        (entry.worker, entry.seq, entry.secs),
        (waiter.pubkey(), 0, 600)
    );
    assert_eq!(w.env.lamports(&w.entry(0)), STAKE + w.rent());
    Ok(())
}

#[test]
fn every_waiter_is_refunded_after_a_cancel() -> TestResult {
    let mut w = world()?;
    let [holder, a, b, cranker] = &w.workers::<4>()?;
    w.claim(holder, 600)?;
    let a_before = w.env.lamports(&a.pubkey());
    let b_before = w.env.lamports(&b.pubkey());
    w.stand_by(a, 0, 600)?;
    w.stand_by(b, 1, 600)?;
    let holder_before = w.env.lamports(&holder.pubkey());
    w.cancel_paying(&holder.pubkey())?;
    assert_eq!(w.env.lamports(&holder.pubkey()), holder_before + STAKE);
    let intent = w.intent();
    let owner = w.owner();
    assert_eq!(
        w.advance(&[0], Some(&a.pubkey())).err(),
        Some(engine_error_at(0, EngineError::InvalidTransition)),
        "nobody is handed a cancelled job"
    );
    w.leave(cranker, 0, &a.pubkey())?;
    w.leave(cranker, 1, &b.pubkey())?;
    assert_eq!(w.env.lamports(&a.pubkey()), a_before);
    assert_eq!(w.env.lamports(&b.pubkey()), b_before);
    assert!(!w.env.exists(&w.entry(0)) && !w.env.exists(&w.entry(1)));
    w.run(&[settle_claims_ix(&intent, &owner, None)], &[])?;
    assert!(!w.env.exists(&claims_pda(&intent)));
    Ok(())
}

#[test]
fn once_the_escrow_expires_anyone_returns_a_waiter_its_stake() -> TestResult {
    let mut w = world()?;
    let [holder, waiter, cranker] = &w.workers::<3>()?;
    w.claim(holder, 600)?;
    let before = w.env.lamports(&waiter.pubkey());
    w.stand_by(waiter, 0, 600)?;
    let expires = load::<intent_engine::state::Intent>(&w.env.svm, &w.intent())?.expires_at;
    w.env.set_now(expires);
    assert_eq!(
        w.advance(&[0], Some(&waiter.pubkey())).err(),
        Some(engine_error_at(0, EngineError::InvalidTransition))
    );
    w.leave(cranker, 0, &waiter.pubkey())?;
    assert_eq!(w.env.lamports(&waiter.pubkey()), before);
    assert!(!w.env.exists(&w.entry(0)));
    Ok(())
}
