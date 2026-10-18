use anchor_lang::prelude::Pubkey;
use intent_core::kinds::{attested_result, Kind};
use intent_engine::errors::EngineError;
use intent_engine::events::{
    ClaimDropped, ClaimsClosed, ClaimsOpened, JobClaimed, StakeMoved, STAKE_TO_OWNER,
    STAKE_TO_WORKER,
};
use intent_engine::state::{ClaimBoard, Intent, CLAIMS_OPEN};
use litesvm::types::TransactionMetadata;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    attestation_proof_message, claim_job_ix, claims_pda, drop_claim_ix, ed25519_ix,
    engine_error_at, events, intent_pda, load, open_claims_ix, settle_claims_ix, swap_spec, Env,
    IntentSpec, Market, Solver, TestResult, Trader, DOMAIN,
};

const FUNDED: u64 = 1_000;
const ESCROW: u64 = 400;
const SPEC: [u8; 32] = [0x3e; 32];
const STAKE: u64 = 50_000_000;
const HOUR: u32 = 3_600;

struct World {
    env: Env,
    market: Market,
    trader: Trader,
    attestor: Keypair,
    worker: Solver,
    rival: Solver,
    fee_to: Pubkey,
}

fn proof_spec(attestor: &Pubkey, spec_hash: [u8; 32]) -> TestResult<IntentSpec> {
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
        ..swap_spec(0, ESCROW)?
    })
}

fn world() -> TestResult<World> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(anchor_spl::token::ID, &[], anchor_spl::token::ID, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let attestor = Keypair::new();
    env.create_intent(&trader, &market, &proof_spec(&attestor.pubkey(), SPEC)?)?;
    let worker = env.solver(&market, 0)?;
    let rival = env.solver(&market, 0)?;
    let fee_to = env.fee_account(&market)?;
    Ok(World {
        env,
        market,
        trader,
        attestor,
        worker,
        rival,
        fee_to,
    })
}

impl World {
    fn owner(&self) -> Pubkey {
        self.trader.key.pubkey()
    }

    fn intent(&self) -> Pubkey {
        intent_pda(&self.owner(), 0)
    }

    fn open(&mut self, max_secs: u32, stake: u64) -> Result<TransactionMetadata, TransactionError> {
        let ix = open_claims_ix(&self.owner(), &self.intent(), max_secs, stake);
        let owner = self.trader.key.insecure_clone();
        self.env.send(&owner, &[ix], &[])
    }

    fn claim(&mut self, who: &Keypair, secs: u32) -> Result<TransactionMetadata, TransactionError> {
        let ix = claim_job_ix(&who.pubkey(), &self.intent(), &self.owner(), secs);
        self.env.send(who, &[ix], &[])
    }

    fn release(
        &mut self,
        to: &Solver,
        claims: bool,
        stake_to: Option<&Pubkey>,
    ) -> Result<TransactionMetadata, TransactionError> {
        let message = attestation_proof_message(
            DOMAIN,
            &self.attestor.pubkey(),
            &self.intent(),
            &to.input,
            ESCROW,
            1,
            SPEC,
        );
        let owner = self.owner();
        self.env.claims = claims.then(|| claims_pda(&self.intent()));
        self.env.stake_to = stake_to.copied();
        let fill = self.env.fill_attested_ix(
            &to.key.pubkey(),
            &owner,
            &self.market,
            0,
            &to.input,
            Some(&self.fee_to),
            1,
        );
        self.env.claims = None;
        self.env.stake_to = None;
        self.env
            .send(&to.key, &[ed25519_ix(&self.attestor, &message), fill], &[])
    }

    fn cancel(
        &mut self,
        claims: bool,
        stake_to: Option<&Pubkey>,
    ) -> Result<TransactionMetadata, TransactionError> {
        let owner = self.owner();
        self.env.claims = claims.then(|| claims_pda(&self.intent()));
        self.env.stake_to = stake_to.copied();
        let cancel = self
            .env
            .cancel_ix(&owner, &self.market, 0, &self.trader.input);
        self.env.claims = None;
        self.env.stake_to = None;
        let trader = self.trader.key.insecure_clone();
        self.env.send(&trader, &[cancel], &[])
    }

    fn board(&self) -> TestResult<ClaimBoard> {
        load(&self.env.svm, &claims_pda(&self.intent()))
    }

    fn lapse(&mut self, secs: u32) {
        let now = self.env.now();
        self.env.set_now(now.saturating_add(i64::from(secs)));
    }
}

#[test]
fn only_the_owner_opens_claims_once_on_an_open_proof_escrow_within_bounds() -> TestResult {
    let mut w = world()?;
    let stranger = w.env.funded()?;
    let forged = open_claims_ix(&stranger.pubkey(), &w.intent(), HOUR, STAKE);
    assert!(w.env.send(&stranger, &[forged], &[]).is_err());
    assert_eq!(
        w.open(0, STAKE).err(),
        Some(engine_error_at(0, EngineError::ClaimTerms))
    );
    let meta = w.open(HOUR, STAKE)?;
    let opened: Vec<_> = events::<ClaimsOpened>(&meta)
        .into_iter()
        .map(|e| (e.intent, e.owner, e.max_secs, e.stake))
        .collect();
    assert_eq!(opened, [(w.intent(), w.owner(), HOUR, STAKE)]);
    let intent: Intent = load(&w.env.svm, &w.intent())?;
    assert_eq!(intent.claims, CLAIMS_OPEN);
    let board = w.board()?;
    assert_eq!(
        (board.stake, board.max_secs, board.owner, board.intent),
        (STAKE, HOUR, w.owner(), w.intent())
    );
    assert!(w.open(HOUR, STAKE).is_err(), "claims open once");
    Ok(())
}

#[test]
fn claims_need_a_proof_escrow() -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(anchor_spl::token::ID, &[], anchor_spl::token::ID, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    env.create_intent(
        &trader,
        &market,
        &proof_spec(&Keypair::new().pubkey(), [0; 32])?,
    )?;
    let ix = open_claims_ix(
        &trader.key.pubkey(),
        &intent_pda(&trader.key.pubkey(), 0),
        HOUR,
        STAKE,
    );
    assert_eq!(
        env.send(&trader.key, &[ix], &[]).err(),
        Some(engine_error_at(0, EngineError::NotAProof))
    );
    Ok(())
}

#[test]
fn a_claim_takes_the_stake_holds_the_job_and_lasts_within_the_terms() -> TestResult {
    let mut w = world()?;
    w.open(HOUR, STAKE)?;
    let worker = w.worker.key.insecure_clone();
    let rival = w.rival.key.insecure_clone();
    let before = w.env.lamports(&worker.pubkey());
    assert_eq!(
        w.claim(&worker, HOUR + 1).err(),
        Some(engine_error_at(0, EngineError::ClaimTerms))
    );
    let meta = w.claim(&worker, HOUR)?;
    let now = w.env.now();
    let claimed: Vec<_> = events::<JobClaimed>(&meta)
        .into_iter()
        .map(|e| (e.worker, e.until, e.stake))
        .collect();
    assert_eq!(claimed, [(worker.pubkey(), now + i64::from(HOUR), STAKE)]);
    assert!(before - w.env.lamports(&worker.pubkey()) >= STAKE);
    assert_eq!(w.board()?.held, STAKE);
    assert_eq!(
        w.claim(&rival, 60).err(),
        Some(engine_error_at(0, EngineError::ClaimHeld))
    );
    Ok(())
}

#[test]
fn while_held_only_the_claimant_is_paid_and_gets_its_stake_back() -> TestResult {
    let mut w = world()?;
    w.open(HOUR, STAKE)?;
    let worker = w.worker.key.insecure_clone();
    w.claim(&worker, HOUR)?;
    let rival = w.rival.key.insecure_clone();
    let rival_solver = Solver {
        key: rival,
        output: w.rival.output,
        input: w.rival.input,
    };
    assert_eq!(
        w.release(&rival_solver, true, None).err(),
        Some(engine_error_at(1, EngineError::ClaimHeld)),
        "nobody but the claimant is paid while the claim holds"
    );
    let worker_solver = Solver {
        key: worker.insecure_clone(),
        output: w.worker.output,
        input: w.worker.input,
    };
    assert_eq!(
        w.release(&worker_solver, false, None).err(),
        Some(engine_error_at(1, EngineError::ClaimsMissing)),
        "a release must show the claims board"
    );
    let owner = w.owner();
    assert_eq!(
        w.release(&worker_solver, true, Some(&owner)).err(),
        Some(engine_error_at(1, EngineError::StakeAccountMismatch)),
        "the stake goes back to the claimant, not elsewhere"
    );
    let board_before = w.env.lamports(&claims_pda(&w.intent()));
    let meta = w.release(&worker_solver, true, Some(&worker.pubkey()))?;
    assert_eq!(
        board_before - w.env.lamports(&claims_pda(&w.intent())),
        STAKE
    );
    assert_eq!(w.env.balance(&w.worker.input)?, ESCROW - 1);
    let moved: Vec<_> = events::<StakeMoved>(&meta)
        .into_iter()
        .map(|e| (e.worker, e.to, e.amount, e.role))
        .collect();
    assert_eq!(
        moved,
        [(worker.pubkey(), worker.pubkey(), STAKE, STAKE_TO_WORKER)]
    );
    let board = w.board()?;
    assert_eq!((board.worker, board.held), (Pubkey::default(), 0));
    Ok(())
}

#[test]
fn a_lapsed_claim_frees_the_job_and_forfeits_the_stake_to_the_owner() -> TestResult {
    let mut w = world()?;
    w.open(HOUR, STAKE)?;
    let worker = w.worker.key.insecure_clone();
    w.claim(&worker, 60)?;
    w.lapse(60);
    let owner = w.owner();
    let before = w.env.lamports(&owner);
    let rival = w.rival.key.insecure_clone();
    let meta = w.claim(&rival, 60)?;
    let moved: Vec<_> = events::<StakeMoved>(&meta)
        .into_iter()
        .map(|e| (e.worker, e.to, e.amount, e.role))
        .collect();
    assert_eq!(moved, [(worker.pubkey(), owner, STAKE, STAKE_TO_OWNER)]);
    assert_eq!(w.env.lamports(&owner), before + STAKE);
    assert_eq!(w.board()?.worker, rival.pubkey());
    Ok(())
}

#[test]
fn a_lapsed_claim_lets_anyone_be_paid_and_sends_the_stake_to_the_owner() -> TestResult {
    let mut w = world()?;
    w.open(HOUR, STAKE)?;
    let worker = w.worker.key.insecure_clone();
    w.claim(&worker, 60)?;
    w.lapse(60);
    let owner = w.owner();
    let rival = Solver {
        key: w.rival.key.insecure_clone(),
        output: w.rival.output,
        input: w.rival.input,
    };
    let before = w.env.lamports(&owner);
    w.release(&rival, true, Some(&owner))?;
    assert_eq!(w.env.balance(&w.rival.input)?, ESCROW - 1);
    assert_eq!(w.env.lamports(&owner), before + STAKE);
    Ok(())
}

#[test]
fn a_lapsed_worker_paid_for_its_own_delivery_still_forfeits_the_stake() -> TestResult {
    let mut w = world()?;
    w.open(HOUR, STAKE)?;
    let worker = w.worker.key.insecure_clone();
    w.claim(&worker, 60)?;
    w.lapse(60);
    let owner = w.owner();
    let payee = Solver {
        key: worker,
        output: w.worker.output,
        input: w.worker.input,
    };
    let before = w.env.lamports(&owner);
    w.release(&payee, true, Some(&owner))?;
    assert_eq!(w.env.balance(&w.worker.input)?, ESCROW - 1);
    assert_eq!(w.env.lamports(&owner), before + STAKE);
    Ok(())
}

#[test]
fn a_claimant_who_gives_up_gets_the_stake_back_and_no_one_else_can_drop_it() -> TestResult {
    let mut w = world()?;
    w.open(HOUR, STAKE)?;
    let worker = w.worker.key.insecure_clone();
    let rival = w.rival.key.insecure_clone();
    w.claim(&worker, HOUR)?;
    let intent = w.intent();
    assert_eq!(
        w.env
            .send(&rival, &[drop_claim_ix(&rival.pubkey(), &intent)], &[])
            .err(),
        Some(engine_error_at(0, EngineError::NotClaimant))
    );
    let before = w.env.lamports(&worker.pubkey());
    let meta = w
        .env
        .send(&worker, &[drop_claim_ix(&worker.pubkey(), &intent)], &[])?;
    let dropped: Vec<_> = events::<ClaimDropped>(&meta)
        .into_iter()
        .map(|e| (e.worker, e.refunded))
        .collect();
    assert_eq!(dropped, [(worker.pubkey(), STAKE)]);
    assert!(w.env.lamports(&worker.pubkey()) + 10_000 > before + STAKE);
    w.claim(&rival, 60)?;
    Ok(())
}

#[test]
fn cancelling_under_a_held_claim_refunds_the_stake_at_once_and_settling_closes_the_board(
) -> TestResult {
    let mut w = world()?;
    w.open(HOUR, STAKE)?;
    let worker = w.worker.key.insecure_clone();
    w.claim(&worker, HOUR)?;
    let intent = w.intent();
    let owner = w.owner();
    let cranker = w.env.funded()?;
    assert_eq!(
        w.env
            .send(
                &cranker,
                &[settle_claims_ix(&intent, &owner, Some(&worker.pubkey()))],
                &[]
            )
            .err(),
        Some(engine_error_at(0, EngineError::ClaimHeld)),
        "an active claim on an open escrow is not settled early"
    );
    let before = w.env.lamports(&worker.pubkey());
    let meta = w.cancel(true, Some(&worker.pubkey()))?;
    assert_eq!(w.env.lamports(&worker.pubkey()), before + STAKE);
    let moved: Vec<_> = events::<StakeMoved>(&meta)
        .into_iter()
        .map(|e| (e.worker, e.to, e.amount, e.role))
        .collect();
    assert_eq!(
        moved,
        [(worker.pubkey(), worker.pubkey(), STAKE, STAKE_TO_WORKER)]
    );
    assert_eq!(w.board()?.worker, Pubkey::default());
    let meta = w
        .env
        .send(&cranker, &[settle_claims_ix(&intent, &owner, None)], &[])?;
    assert!(events::<StakeMoved>(&meta).is_empty());
    assert_eq!(events::<ClaimsClosed>(&meta).len(), 1);
    assert!(
        !w.env.exists(&claims_pda(&intent)),
        "the board closes once the escrow is done"
    );
    Ok(())
}

#[test]
fn an_owner_who_cancels_just_before_the_claim_lapses_cannot_keep_the_stake() -> TestResult {
    let mut w = world()?;
    w.open(HOUR, STAKE)?;
    let worker = w.worker.key.insecure_clone();
    w.claim(&worker, 600)?;
    w.lapse(599);
    let owner = w.owner();
    let owner_before = w.env.lamports(&owner);
    let worker_before = w.env.lamports(&worker.pubkey());
    w.cancel(true, Some(&worker.pubkey()))?;
    w.lapse(1);
    let cranker = w.env.funded()?;
    let intent = w.intent();
    w.env
        .send(&cranker, &[settle_claims_ix(&intent, &owner, None)], &[])?;
    assert_eq!(w.env.lamports(&worker.pubkey()), worker_before + STAKE);
    let board_rent = w.env.lamports(&owner) - owner_before;
    assert!(
        board_rent < STAKE,
        "the owner gets the board's rent back, never the stake"
    );
    Ok(())
}

#[test]
fn a_cancel_that_hides_the_board_or_redirects_the_stake_is_refused() -> TestResult {
    let mut w = world()?;
    w.open(HOUR, STAKE)?;
    let worker = w.worker.key.insecure_clone();
    w.claim(&worker, HOUR)?;
    let owner = w.owner();
    assert_eq!(
        w.cancel(false, None).err(),
        Some(engine_error_at(0, EngineError::ClaimsMissing))
    );
    assert_eq!(
        w.cancel(true, Some(&owner)).err(),
        Some(engine_error_at(0, EngineError::StakeAccountMismatch))
    );
    assert_eq!(
        w.cancel(true, None).err(),
        Some(engine_error_at(0, EngineError::StakeAccountMismatch))
    );
    w.cancel(true, Some(&worker.pubkey()))?;
    Ok(())
}

#[test]
fn a_cancel_after_the_claim_lapsed_forfeits_the_stake_to_the_owner() -> TestResult {
    let mut w = world()?;
    w.open(HOUR, STAKE)?;
    let worker = w.worker.key.insecure_clone();
    w.claim(&worker, 60)?;
    w.lapse(60);
    let owner = w.owner();
    let before = w.env.lamports(&owner);
    let meta = w.cancel(true, Some(&owner))?;
    let moved: Vec<_> = events::<StakeMoved>(&meta)
        .into_iter()
        .map(|e| (e.worker, e.to, e.amount, e.role))
        .collect();
    assert_eq!(moved, [(worker.pubkey(), owner, STAKE, STAKE_TO_OWNER)]);
    assert!(w.env.lamports(&owner) + 10_000 > before + STAKE);
    Ok(())
}

#[test]
fn a_cancel_with_no_claim_held_moves_no_stake() -> TestResult {
    let mut w = world()?;
    w.open(HOUR, STAKE)?;
    let meta = w.cancel(true, None)?;
    assert!(events::<StakeMoved>(&meta).is_empty());
    assert_eq!(w.board()?.held, 0);
    Ok(())
}

#[test]
fn a_worker_that_drops_cannot_claim_again_before_its_term_ends() -> TestResult {
    let mut w = world()?;
    w.open(HOUR, STAKE)?;
    let worker = w.worker.key.insecure_clone();
    w.claim(&worker, 600)?;
    let until = w.board()?.until;
    w.lapse(599);
    let intent = w.intent();
    let owner = w.owner();
    let renew = [
        drop_claim_ix(&worker.pubkey(), &intent),
        claim_job_ix(&worker.pubkey(), &intent, &owner, HOUR),
    ];
    assert_eq!(
        w.env.send(&worker, &renew, &[]).err(),
        Some(engine_error_at(1, EngineError::ClaimCooldown)),
        "dropping and claiming again in one transaction is refused"
    );
    w.env
        .send(&worker, &[drop_claim_ix(&worker.pubkey(), &intent)], &[])?;
    let board = w.board()?;
    assert_eq!(
        (board.worker, board.until, board.held, board.dropped_by),
        (Pubkey::default(), until, 0, worker.pubkey())
    );
    assert_eq!(
        w.claim(&worker, 60).err(),
        Some(engine_error_at(0, EngineError::ClaimCooldown))
    );
    w.lapse(1);
    w.claim(&worker, 60)?;
    assert_eq!(w.board()?.dropped_by, Pubkey::default());
    Ok(())
}

#[test]
fn a_dropped_job_is_free_for_everyone_else_at_once() -> TestResult {
    let mut w = world()?;
    w.open(HOUR, STAKE)?;
    let worker = w.worker.key.insecure_clone();
    let rival = w.rival.key.insecure_clone();
    w.claim(&worker, HOUR)?;
    let intent = w.intent();
    w.env
        .send(&worker, &[drop_claim_ix(&worker.pubkey(), &intent)], &[])?;
    w.claim(&rival, 60)?;
    let board = w.board()?;
    assert_eq!(
        (board.worker, board.dropped_by),
        (rival.pubkey(), Pubkey::default())
    );
    w.lapse(60);
    w.claim(&worker, 60)?;
    Ok(())
}

#[test]
fn settling_a_lapsed_claim_on_an_open_escrow_forfeits_the_stake_and_keeps_the_board() -> TestResult
{
    let mut w = world()?;
    w.open(HOUR, STAKE)?;
    let worker = w.worker.key.insecure_clone();
    w.claim(&worker, 60)?;
    w.lapse(60);
    let intent = w.intent();
    let owner = w.owner();
    let before = w.env.lamports(&owner);
    let cranker = w.env.funded()?;
    w.env
        .send(&cranker, &[settle_claims_ix(&intent, &owner, None)], &[])?;
    assert_eq!(w.env.lamports(&owner), before + STAKE);
    assert!(w.env.exists(&claims_pda(&intent)));
    assert_eq!(w.board()?.worker, Pubkey::default());
    assert_eq!(
        w.env
            .send(&cranker, &[settle_claims_ix(&intent, &owner, None)], &[])
            .err(),
        Some(engine_error_at(0, EngineError::InvalidTransition)),
        "nothing left to settle"
    );
    Ok(())
}

#[test]
fn an_escrow_without_claims_releases_as_before() -> TestResult {
    let mut w = world()?;
    let to = Solver {
        key: w.rival.key.insecure_clone(),
        output: w.rival.output,
        input: w.rival.input,
    };
    w.release(&to, false, None)?;
    assert_eq!(w.env.balance(&w.rival.input)?, ESCROW - 1);
    Ok(())
}
