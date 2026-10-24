use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use intent_core::kinds::{attested_result, Kind};
use intent_core::roster::MAX_CLAIMANTS;
use intent_engine::errors::EngineError;
use intent_engine::events::{ClaimantsListed, ClaimsClosed, StakeMoved, STAKE_TO_WORKER};
use intent_engine::state::{ClaimBoard, ClaimList, CLAIM_LIST_VERSION, LISTED};
use litesvm::types::TransactionMetadata;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    anchor_error_at, attestation_proof_message, claim_job_listed_ix, claim_list_pda, claims_pda,
    close_legacy_full_ix, ed25519_ix, engine_error_at, events, extend_claimants_ix, intent_pda,
    list_claimants_ix, load, open_claims_ix, open_claims_listed_ix, settle_claims_listed_ix,
    stand_by_listed_ix, swap_spec, Env, IntentSpec, LegacyClose, Market, Solver, TestResult,
    Trader, DOMAIN,
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
    attestor: Keypair,
    worker: Solver,
    mate: Solver,
    stranger: Solver,
    fee_to: Pubkey,
    cranker: Keypair,
}

fn proof_spec(nonce: u64, attestor: &Pubkey) -> TestResult<IntentSpec> {
    Ok(IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: ESCROW,
            min_result: 1,
            max_result: 1,
            attestor: attestor.to_bytes(),
            spec_hash: SPEC,
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
    let attestor = Keypair::new();
    env.create_intent(&trader, &market, &proof_spec(0, &attestor.pubkey())?)?;
    let worker = env.solver(&market, 0)?;
    let mate = env.solver(&market, 0)?;
    let stranger = env.solver(&market, 0)?;
    let fee_to = env.fee_account(&market)?;
    let cranker = env.funded()?;
    Ok(World {
        env,
        market,
        trader,
        attestor,
        worker,
        mate,
        stranger,
        fee_to,
        cranker,
    })
}

fn key(solver: &Solver) -> Keypair {
    solver.key.insecure_clone()
}

impl World {
    fn owner(&self) -> Pubkey {
        self.trader.key.pubkey()
    }

    fn intent(&self) -> Pubkey {
        intent_pda(&self.owner(), 0)
    }

    fn list(&self) -> Pubkey {
        claim_list_pda(&self.intent())
    }

    fn as_owner(
        &mut self,
        ix: solana_instruction::Instruction,
    ) -> Result<TransactionMetadata, TransactionError> {
        let owner = self.trader.key.insecure_clone();
        self.env.send(&owner, &[ix], &[])
    }

    fn open_listed(
        &mut self,
        size: u8,
        workers: &[Pubkey],
    ) -> Result<TransactionMetadata, TransactionError> {
        let ix = open_claims_listed_ix(&self.owner(), &self.intent(), HOUR, STAKE, size, workers);
        self.as_owner(ix)
    }

    fn claim(
        &mut self,
        who: &Keypair,
        list: Option<Pubkey>,
    ) -> Result<TransactionMetadata, TransactionError> {
        let ix = claim_job_listed_ix(&who.pubkey(), &self.intent(), &self.owner(), HOUR, list);
        self.env.send(who, &[ix], &[])
    }

    fn stand_by(
        &mut self,
        who: &Keypair,
        seq: u32,
        list: Option<Pubkey>,
    ) -> Result<TransactionMetadata, TransactionError> {
        let ix = stand_by_listed_ix(&who.pubkey(), &self.intent(), seq, 60, list);
        self.env.send(who, &[ix], &[])
    }

    fn release(
        &mut self,
        to: &Solver,
        stake_to: &Pubkey,
    ) -> Result<TransactionMetadata, TransactionError> {
        let delivery = self.env.announce_or_clear(&to.key, &self.intent());
        let message = attestation_proof_message(
            DOMAIN,
            &self.attestor.pubkey(),
            &self.intent(),
            &to.input,
            ESCROW,
            1,
            SPEC,
            &delivery,
        );
        let owner = self.owner();
        self.env.claims = Some(claims_pda(&self.intent()));
        self.env.stake_to = Some(*stake_to);
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

    fn cancel(&mut self) -> Result<TransactionMetadata, TransactionError> {
        let owner = self.owner();
        self.env.claims = Some(claims_pda(&self.intent()));
        let cancel = self
            .env
            .cancel_ix(&owner, &self.market, 0, &self.trader.input);
        self.env.claims = None;
        let trader = self.trader.key.insecure_clone();
        self.env.send(&trader, &[cancel], &[])
    }

    fn settle(&mut self, list: Option<Pubkey>) -> Result<TransactionMetadata, TransactionError> {
        let cranker = self.cranker.insecure_clone();
        let ix = settle_claims_listed_ix(&self.intent(), &self.owner(), None, list);
        self.env.send(&cranker, &[ix], &[])
    }

    fn board(&self) -> TestResult<ClaimBoard> {
        load(&self.env.svm, &claims_pda(&self.intent()))
    }

    fn claim_list(&self) -> TestResult<ClaimList> {
        load(&self.env.svm, &self.list())
    }
}

#[test]
fn an_unlisted_wallet_is_refused_on_chain_with_and_without_the_list_while_a_listed_one_is_paid(
) -> TestResult {
    let mut w = world()?;
    let (worker, mate, stranger) = (key(&w.worker), key(&w.mate), key(&w.stranger));
    let listed = [worker.pubkey(), mate.pubkey()];
    let meta = w.open_listed(2, &listed)?;
    let shown: Vec<_> = events::<ClaimantsListed>(&meta)
        .into_iter()
        .map(|e| (e.intent, e.owner, e.size, e.count, e.workers))
        .collect();
    assert_eq!(shown, [(w.intent(), w.owner(), 2, 2, listed.to_vec())]);
    assert_eq!(w.board()?.listed, LISTED);
    let list = w.list();
    assert_eq!(
        w.claim(&stranger, Some(list)).err(),
        Some(engine_error_at(0, EngineError::NotListed))
    );
    assert_eq!(
        w.claim(&stranger, None).err(),
        Some(engine_error_at(0, EngineError::ClaimListMissing))
    );
    w.claim(&worker, Some(list))?;
    assert_eq!(w.board()?.worker, worker.pubkey());
    assert_eq!(
        w.stand_by(&stranger, 0, Some(list)).err(),
        Some(engine_error_at(0, EngineError::NotListed))
    );
    assert_eq!(
        w.stand_by(&stranger, 0, None).err(),
        Some(engine_error_at(0, EngineError::ClaimListMissing))
    );
    w.stand_by(&mate, 0, Some(list))?;
    let worker_solver = Solver {
        key: worker.insecure_clone(),
        output: w.worker.output,
        input: w.worker.input,
    };
    let meta = w.release(&worker_solver, &worker.pubkey())?;
    assert_eq!(Some(w.env.balance(&w.worker.input)?), ESCROW.checked_sub(1));
    let moved: Vec<_> = events::<StakeMoved>(&meta)
        .into_iter()
        .map(|e| (e.worker, e.to, e.amount, e.role))
        .collect();
    assert_eq!(
        moved,
        [(worker.pubkey(), worker.pubkey(), STAKE, STAKE_TO_WORKER)]
    );
    Ok(())
}

#[test]
fn another_escrows_list_cannot_stand_in_for_this_one() -> TestResult {
    let mut w = world()?;
    let stranger = key(&w.stranger);
    let other = proof_spec(1, &w.attestor.pubkey())?;
    w.env.create_intent(&w.trader, &w.market, &other)?;
    let other_intent = intent_pda(&w.owner(), 1);
    let open_other = open_claims_listed_ix(
        &w.owner(),
        &other_intent,
        HOUR,
        STAKE,
        1,
        &[stranger.pubkey()],
    );
    w.as_owner(open_other)?;
    w.open_listed(1, &[w.worker.key.pubkey()])?;
    assert_eq!(
        w.claim(&stranger, Some(claim_list_pda(&other_intent)))
            .err(),
        Some(anchor_error_at(0, ErrorCode::ConstraintSeeds))
    );
    Ok(())
}

#[test]
fn an_escrow_without_a_list_takes_claims_from_anyone_as_before() -> TestResult {
    let mut w = world()?;
    let stranger = key(&w.stranger);
    let open = open_claims_ix(&w.owner(), &w.intent(), HOUR, STAKE);
    w.as_owner(open)?;
    assert_eq!(w.board()?.listed, 0);
    assert!(!w.env.exists(&w.list()));
    w.claim(&stranger, None)?;
    assert_eq!(w.board()?.worker, stranger.pubkey());
    let worker = key(&w.worker);
    w.stand_by(&worker, 0, None)?;
    Ok(())
}

#[test]
fn the_lists_rent_returns_to_the_owner_when_the_board_settles() -> TestResult {
    let mut w = world()?;
    w.open_listed(1, &[w.worker.key.pubkey()])?;
    let board_rent = w.env.lamports(&claims_pda(&w.intent()));
    let list_rent = w.env.lamports(&w.list());
    assert!(list_rent > 0);
    w.cancel()?;
    assert_eq!(
        w.settle(None).err(),
        Some(engine_error_at(0, EngineError::ClaimListMissing))
    );
    let owner = w.owner();
    let before = w.env.lamports(&owner);
    let meta = w.settle(Some(w.list()))?;
    assert_eq!(events::<ClaimsClosed>(&meta).len(), 1);
    assert!(!w.env.exists(&claims_pda(&w.intent())));
    assert!(!w.env.exists(&w.list()));
    assert_eq!(
        Some(w.env.lamports(&owner)),
        before
            .checked_add(board_rent)
            .and_then(|v| v.checked_add(list_rent))
    );
    Ok(())
}

#[test]
fn an_unlisted_board_settles_as_before_and_ignores_no_list() -> TestResult {
    let mut w = world()?;
    let open = open_claims_ix(&w.owner(), &w.intent(), HOUR, STAKE);
    w.as_owner(open)?;
    let board_rent = w.env.lamports(&claims_pda(&w.intent()));
    w.cancel()?;
    let owner = w.owner();
    let before = w.env.lamports(&owner);
    w.settle(None)?;
    assert!(!w.env.exists(&claims_pda(&w.intent())));
    assert_eq!(Some(w.env.lamports(&owner)), before.checked_add(board_rent));
    Ok(())
}

#[test]
fn only_the_owner_lists_once_while_nobody_holds_or_waits() -> TestResult {
    let mut w = world()?;
    let (worker, mate, stranger) = (key(&w.worker), key(&w.mate), key(&w.stranger));
    let open = open_claims_ix(&w.owner(), &w.intent(), HOUR, STAKE);
    w.as_owner(open)?;
    let forged = list_claimants_ix(&stranger.pubkey(), &w.intent(), 1, &[stranger.pubkey()]);
    assert!(w.env.send(&stranger, &[forged], &[]).is_err());
    w.claim(&stranger, None)?;
    let held = list_claimants_ix(&w.owner(), &w.intent(), 1, &[worker.pubkey()]);
    assert_eq!(
        w.as_owner(held.clone()).err(),
        Some(engine_error_at(0, EngineError::ClaimHeld))
    );
    w.stand_by(&mate, 0, None)?;
    let drop = svm_tests::drop_claim_line_ix(
        &stranger.pubkey(),
        &w.intent(),
        &[svm_tests::standby_pda(&w.intent(), 0)],
        Some(&mate.pubkey()),
    );
    w.env.send(&stranger, &[drop], &[])?;
    assert_eq!(w.board()?.worker, mate.pubkey());
    let mate_drop = svm_tests::drop_claim_ix(&mate.pubkey(), &w.intent());
    w.env.send(&mate, &[mate_drop], &[])?;
    let meta = w.as_owner(held.clone())?;
    assert_eq!(events::<ClaimantsListed>(&meta).len(), 1);
    let list = w.claim_list()?;
    assert_eq!(
        (list.intent, list.owner, list.size, list.count, list.version),
        (w.intent(), w.owner(), 1, 1, CLAIM_LIST_VERSION)
    );
    assert!(w.as_owner(held).is_err(), "a list is set once");
    let more = extend_claimants_ix(&w.owner(), &w.intent(), &[mate.pubkey()]);
    assert_eq!(
        w.as_owner(more).err(),
        Some(engine_error_at(0, EngineError::ClaimListSet))
    );
    assert_eq!(
        w.claim(&mate, Some(w.list())).err(),
        Some(engine_error_at(0, EngineError::NotListed))
    );
    w.claim(&worker, Some(w.list()))?;
    Ok(())
}

#[test]
fn a_list_too_large_empty_or_with_repeats_is_refused() -> TestResult {
    let mut w = world()?;
    let worker = w.worker.key.pubkey();
    let too_many: Vec<Pubkey> = (0..=MAX_CLAIMANTS).map(|_| Pubkey::new_unique()).collect();
    let size = u8::try_from(MAX_CLAIMANTS)?;
    let refused = [
        (0, vec![]),
        (size.saturating_add(1), vec![worker]),
        (1, vec![worker, Pubkey::new_unique()]),
        (2, vec![worker, worker]),
        (1, vec![Pubkey::default()]),
        (size, too_many),
    ];
    for (size, workers) in refused {
        assert_eq!(
            w.open_listed(size, &workers).err(),
            Some(engine_error_at(0, EngineError::ClaimListInvalid)),
            "{size} {}",
            workers.len()
        );
    }
    Ok(())
}

#[test]
fn a_list_of_thirty_two_filled_in_parts_takes_no_claim_until_complete() -> TestResult {
    let mut w = world()?;
    let worker = key(&w.worker);
    let mut workers: Vec<Pubkey> = (1..MAX_CLAIMANTS).map(|_| Pubkey::new_unique()).collect();
    workers.push(worker.pubkey());
    let size = u8::try_from(MAX_CLAIMANTS)?;
    let (first, rest) = workers.split_at(10);
    w.open_listed(size, first)?;
    assert_eq!(
        w.claim(&worker, Some(w.list())).err(),
        Some(engine_error_at(0, EngineError::ClaimListIncomplete))
    );
    let stranger = key(&w.stranger);
    let forged = extend_claimants_ix(&stranger.pubkey(), &w.intent(), &[stranger.pubkey()]);
    assert_eq!(
        w.env.send(&stranger, &[forged], &[]).err(),
        Some(engine_error_at(0, EngineError::Unauthorized))
    );
    let (middle, last) = rest.split_at(11);
    let repeat = extend_claimants_ix(&w.owner(), &w.intent(), first.get(..1).ok_or("empty")?);
    assert_eq!(
        w.as_owner(repeat).err(),
        Some(engine_error_at(0, EngineError::ClaimListInvalid))
    );
    w.as_owner(extend_claimants_ix(&w.owner(), &w.intent(), middle))?;
    assert_eq!(w.claim_list()?.count, 21);
    w.as_owner(extend_claimants_ix(&w.owner(), &w.intent(), last))?;
    let list = w.claim_list()?;
    assert_eq!((list.count, list.size), (size, size));
    assert_eq!(list.workers.to_vec(), workers);
    w.claim(&worker, Some(w.list()))?;
    Ok(())
}

#[test]
fn a_list_of_another_version_closes_to_its_owner_only_once_its_escrow_ends() -> TestResult {
    let mut w = world()?;
    w.open_listed(1, &[w.worker.key.pubkey()])?;
    let address = w.list();
    let mut account = w.env.svm.get_account(&address).ok_or("list missing")?;
    let at = core::mem::offset_of!(ClaimList, version).saturating_add(8);
    *account.data.get_mut(at).ok_or("short")? = CLAIM_LIST_VERSION.saturating_add(1);
    w.env.svm.set_account(address, account)?;
    let owner = w.owner();
    let close = LegacyClose {
        account: address,
        payee: owner,
        with_config: false,
        vault: None,
        stake_to: None,
        intent: Some(w.intent()),
        fee_to: None,
    };
    let cranker = w.cranker.insecure_clone();
    assert_eq!(
        w.env
            .send(&cranker, &[close_legacy_full_ix(&close)], &[])
            .err(),
        Some(engine_error_at(0, EngineError::LegacyLineOpen))
    );
    w.cancel()?;
    let rent = w.env.lamports(&address);
    let before = w.env.lamports(&owner);
    w.env.send(&cranker, &[close_legacy_full_ix(&close)], &[])?;
    assert!(!w.env.exists(&address));
    assert_eq!(Some(w.env.lamports(&owner)), before.checked_add(rent));
    assert_eq!(
        w.settle(None).err(),
        Some(engine_error_at(0, EngineError::ClaimListMissing))
    );
    w.settle(Some(address))?;
    assert!(!w.env.exists(&claims_pda(&w.intent())));
    Ok(())
}
