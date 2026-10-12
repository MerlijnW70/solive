use anchor_lang::prelude::Pubkey;
use intent_core::lifecycle::Status;
use intent_engine::errors::EngineError;
use intent_engine::events::{FillBegun, FillEnded};
use intent_engine::state::PAUSE_FILL;
use litesvm::types::TransactionMetadata;
use solana_instruction::Instruction;
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    bump_search_cost,
    cu_gate, engine_error_at, events, intent_pda, relayed, swap_spec, vault_pda, Env, Market,
    Solver, TestResult, Trader, START_TS,
};

const FUNDED: u64 = 1_000;
const ESCROW: u64 = 400;
const SOLVER_FUNDS: u64 = 10_000;

struct World {
    env: Env,
    market: Market,
    trader: Trader,
    solver: Solver,
    fee_to: Pubkey,
}

fn world() -> TestResult<World> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(PROGRAM, &[], PROGRAM, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let solver = env.solver(&market, SOLVER_FUNDS)?;
    let fee_to = env.fee_account(&market)?;
    env.create_intent(&trader, &market, &swap_spec(0, ESCROW)?)?;
    Ok(World {
        env,
        market,
        trader,
        solver,
        fee_to,
    })
}

impl World {
    fn owner(&self) -> Pubkey {
        self.trader.key.pubkey()
    }

    fn begin(&self, nonce: u64, end_index: u16) -> Instruction {
        self.env.begin_fill_ix(
            &self.solver.key.pubkey(),
            &self.owner(),
            &self.market,
            nonce,
            &self.solver.input,
            Some(&self.fee_to),
            end_index,
        )
    }

    fn end(&self, nonce: u64, amount_out: u64) -> Instruction {
        self.env.end_fill_ix(
            &self.solver.key.pubkey(),
            &self.owner(),
            &self.market,
            nonce,
            &self.trader.receiver,
            &self.solver.output,
            amount_out,
        )
    }

    fn send(&mut self, ixs: &[Instruction]) -> Result<TransactionMetadata, TransactionError> {
        let solver = self.solver.key.insecure_clone();
        self.env.send(&solver, ixs, &[])
    }
}

#[test]
fn begin_pays_the_solver_and_end_must_deliver_in_the_same_transaction() -> TestResult {
    let mut w = world()?;
    let meta = w.send(&[w.begin(0, 1), w.end(0, 1)])?;
    assert_eq!(w.env.balance(&w.trader.receiver)?, 1);
    assert_eq!(w.env.balance(&w.solver.input)?, ESCROW - 1);
    assert_eq!(w.env.balance(&w.fee_to)?, 1);
    assert_eq!(w.env.balance(&vault_pda(&intent_pda(&w.owner(), 0)))?, 0);
    assert_eq!(w.env.intent(&w.owner(), 0)?.status, Status::Filled as u8);
    let begun = events::<FillBegun>(&meta).pop().ok_or("missing")?;
    assert_eq!(begun.intent, intent_pda(&w.owner(), 0));
    assert_eq!(begun.solver, w.solver.key.pubkey());
    assert_eq!(begun.solver_input, w.solver.input);
    assert_eq!(
        (begun.end_index, begun.amount_in, begun.fee, begun.net),
        (1, ESCROW, 1, ESCROW - 1)
    );
    let ended = events::<FillEnded>(&meta).pop().ok_or("missing")?;
    assert_eq!(ended.intent, intent_pda(&w.owner(), 0));
    assert_eq!(ended.owner, w.owner());
    assert_eq!(ended.solver, w.solver.key.pubkey());
    assert_eq!(ended.receiver, w.trader.receiver);
    assert_eq!((ended.delivered, ended.required), (1, 1));
    Ok(())
}

#[test]
fn the_solver_can_route_between_begin_and_end() -> TestResult {
    let mut w = world()?;
    let solver = w.solver.key.insecure_clone();
    let source = w.env.create_token_account(
        &w.market.output_mint,
        &solver.pubkey(),
        w.market.output_program,
    )?;
    w.env
        .mint_to(&w.market.output_mint, &source, w.market.output_program, 50)?;
    let drained = Solver {
        key: solver.insecure_clone(),
        output: w.solver.output,
        input: w.solver.input,
    };
    let decimals = w.env.decimals(&w.market.output_mint)?;
    let route = anchor_spl::token_2022::spl_token_2022::instruction::transfer_checked(
        &w.market.output_program,
        &source,
        &w.market.output_mint,
        &drained.output,
        &solver.pubkey(),
        &[],
        50,
        decimals,
    )?;
    w.send(&[w.begin(0, 2), route, w.end(0, 50)])?;
    assert_eq!(w.env.balance(&w.trader.receiver)?, 50);
    Ok(())
}

#[test]
fn begin_cannot_be_reached_through_cpi() -> TestResult {
    let mut w = world()?;
    let through = relayed(intent_engine::ID, w.begin(0, 1));
    assert_eq!(
        w.send(&[through, w.end(0, 1)]).err(),
        Some(engine_error_at(0, EngineError::FlashCpi))
    );
    Ok(())
}

#[test]
fn the_end_row_must_exist() -> TestResult {
    let mut w = world()?;
    assert_eq!(
        w.send(&[w.begin(0, 5)]).err(),
        Some(TransactionError::InstructionError(
            0,
            InstructionError::InvalidArgument
        ))
    );
    Ok(())
}

#[test]
fn a_look_alike_end_row_from_another_program_is_rejected() -> TestResult {
    let mut w = world()?;
    let decoy = relayed(intent_pda(&w.owner(), 0), w.end(0, 1));
    assert_eq!(
        w.send(&[w.begin(0, 1), decoy]).err(),
        Some(engine_error_at(0, EngineError::FlashEndProgram))
    );
    Ok(())
}

#[test]
fn the_end_row_must_be_end_fill() -> TestResult {
    let mut w = world()?;
    let other = w.env.expire_ix(
        &w.solver.key.pubkey(),
        &w.owner(),
        &w.market,
        0,
        &w.trader.input,
    );
    assert_eq!(
        w.send(&[w.begin(0, 1), other]).err(),
        Some(engine_error_at(0, EngineError::FlashEndDiscriminator))
    );
    Ok(())
}

#[test]
fn the_end_row_must_close_the_same_intent() -> TestResult {
    let mut w = world()?;
    w.env.mint_to(
        &w.market.input_mint,
        &w.trader.input,
        w.market.input_program,
        ESCROW,
    )?;
    w.env
        .create_intent(&w.trader, &w.market, &swap_spec(1, ESCROW)?)?;
    assert_eq!(
        w.send(&[w.begin(0, 1), w.end(1, 1)]).err(),
        Some(engine_error_at(0, EngineError::FlashEndIntent))
    );
    Ok(())
}

#[test]
fn end_without_begin_is_rejected() -> TestResult {
    let mut w = world()?;
    assert_eq!(
        w.send(&[w.end(0, 1)]).err(),
        Some(engine_error_at(0, EngineError::InvalidTransition))
    );
    Ok(())
}

#[test]
fn an_intent_cannot_be_begun_twice() -> TestResult {
    let mut w = world()?;
    assert_eq!(
        w.send(&[w.begin(0, 2), w.begin(0, 2), w.end(0, 1)]).err(),
        Some(engine_error_at(1, EngineError::InvalidTransition))
    );
    Ok(())
}

#[test]
fn a_filling_intent_cannot_be_cancelled_filled_or_closed() -> TestResult {
    let mut w = world()?;
    let owner = w.trader.key.insecure_clone();
    let cancel = w
        .env
        .cancel_ix(&owner.pubkey(), &w.market, 0, &w.trader.input);
    let solver = w.solver.key.insecure_clone();
    assert_eq!(
        w.env
            .send(&solver, &[w.begin(0, 2), cancel, w.end(0, 1)], &[&owner])
            .err(),
        Some(engine_error_at(1, EngineError::InvalidTransition))
    );
    let fill = w.env.fill_ix(
        &w.solver,
        &w.owner(),
        &w.market,
        0,
        &w.trader.receiver,
        Some(&w.fee_to),
        1,
    );
    assert_eq!(
        w.send(&[w.begin(0, 2), fill, w.end(0, 1)]).err(),
        Some(engine_error_at(1, EngineError::InvalidTransition))
    );
    let close = w.env.close_ix_by(
        &w.solver.key.pubkey(),
        &w.owner(),
        &w.market,
        0,
        &w.trader.input,
    );
    assert_eq!(
        w.send(&[w.begin(0, 2), close, w.end(0, 1)]).err(),
        Some(engine_error_at(1, EngineError::InvalidTransition))
    );
    Ok(())
}

#[test]
fn each_end_measures_only_its_own_delivery() -> TestResult {
    let mut w = world()?;
    w.env.mint_to(
        &w.market.input_mint,
        &w.trader.input,
        w.market.input_program,
        ESCROW,
    )?;
    w.env
        .create_intent(&w.trader, &w.market, &swap_spec(1, ESCROW)?)?;
    assert_eq!(
        w.send(&[w.begin(0, 2), w.begin(1, 3), w.end(0, 2), w.end(1, 0)])
            .err(),
        Some(engine_error_at(3, EngineError::InsufficientOutput))
    );
    w.send(&[w.begin(0, 2), w.begin(1, 3), w.end(0, 1), w.end(1, 1)])?;
    assert_eq!(w.env.balance(&w.trader.receiver)?, 2);
    Ok(())
}

#[test]
fn a_short_delivery_reverts_the_whole_flash_fill() -> TestResult {
    let mut w = world()?;
    let mut params = swap_spec(1, ESCROW)?;
    params.params = intent_core::kinds::swap_exact_in::Params {
        amount_in: ESCROW,
        min_out: 300,
    }
    .encode()
    .map_err(|e| format!("{e:?}"))?;
    w.env.mint_to(
        &w.market.input_mint,
        &w.trader.input,
        w.market.input_program,
        ESCROW,
    )?;
    w.env.create_intent(&w.trader, &w.market, &params)?;
    assert_eq!(
        w.send(&[w.begin(1, 1), w.end(1, 299)]).err(),
        Some(engine_error_at(1, EngineError::InsufficientOutput))
    );
    assert_eq!(w.env.intent(&w.owner(), 1)?.status, Status::Open as u8);
    assert_eq!(
        w.env.balance(&vault_pda(&intent_pda(&w.owner(), 1)))?,
        ESCROW
    );
    assert_eq!(w.env.balance(&w.solver.input)?, 0);
    w.send(&[w.begin(1, 1), w.end(1, 300)])?;
    Ok(())
}

#[test]
fn begin_honours_pause_expiry_and_fee_account_rules() -> TestResult {
    let mut w = world()?;
    let authority = w.env.authority.insecure_clone();
    let ix = w.env.raise_pause_ix(&authority.pubkey(), PAUSE_FILL);
    w.env.send(&authority, &[ix], &[])?;
    assert_eq!(
        w.send(&[w.begin(0, 1), w.end(0, 1)]).err(),
        Some(engine_error_at(0, EngineError::FillPaused))
    );
    let ix = w.env.lower_pause_ix(&authority.pubkey(), PAUSE_FILL);
    w.env.send(&authority, &[ix], &[])?;
    let no_fee_account = w.env.begin_fill_ix(
        &w.solver.key.pubkey(),
        &w.owner(),
        &w.market,
        0,
        &w.solver.input,
        None,
        1,
    );
    assert_eq!(
        w.send(&[no_fee_account, w.end(0, 1)]).err(),
        Some(engine_error_at(0, EngineError::FeeAccountMissing))
    );
    w.env.set_now(START_TS.saturating_add(3_600));
    assert_eq!(
        w.send(&[w.begin(0, 1), w.end(0, 1)]).err(),
        Some(engine_error_at(0, EngineError::IntentExpired))
    );
    Ok(())
}

#[test]
fn end_refuses_solver_funds_held_by_the_owner() -> TestResult {
    let mut w = world()?;
    let owned =
        w.env
            .create_token_account(&w.market.output_mint, &w.owner(), w.market.output_program)?;
    let mut end = w.end(0, 1);
    if let Some(meta) = end.accounts.get_mut(4) {
        meta.pubkey = owned;
    }
    assert_eq!(
        w.send(&[w.begin(0, 1), end]).err(),
        Some(engine_error_at(1, EngineError::SolverOutputNotAllowed))
    );
    Ok(())
}

#[test]
fn attested_intents_cannot_be_flash_filled() -> TestResult {
    let mut w = world()?;
    let attestor = Keypair::new();
    let spec = svm_tests::IntentSpec {
        nonce: 1,
        kind: intent_core::kinds::Kind::AttestedResult as u8,
        params: intent_core::kinds::attested_result::Params {
            amount_in: ESCROW,
            min_result: 1,
            max_result: 2,
            attestor: attestor.pubkey().to_bytes(),
            spec_hash: [0; 32],
            judge_fee: 0,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        expires_at: START_TS.saturating_add(3_600),
        flags: 0,
        ext: Vec::new(),
    };
    w.env.mint_to(
        &w.market.input_mint,
        &w.trader.input,
        w.market.input_program,
        ESCROW,
    )?;
    w.env.create_intent(&w.trader, &w.market, &spec)?;
    assert_eq!(
        w.send(&[w.begin(1, 1), w.end(1, 10)]).err(),
        Some(engine_error_at(0, EngineError::KindMismatch))
    );
    Ok(())
}

#[test]
fn a_flash_fill_stays_within_its_measured_budget() -> TestResult {
    let mut w = world()?;
    let meta = w.send(&[w.begin(0, 1), w.end(0, 1)])?;
    let fee_bump = Pubkey::find_program_address(
        &[
            w.env.config()?.fee_recipient.as_ref(),
            w.market.input_program.as_ref(),
            w.market.input_mint.as_ref(),
        ],
        &anchor_spl::associated_token::ID,
    )
    .1;
    let normalized = meta
        .compute_units_consumed
        .saturating_sub(bump_search_cost(fee_bump));
    cu_gate(&format!("flash_fill{CU_SUFFIX}"), normalized)
}

#[test]
fn the_end_row_must_come_after_begin() -> TestResult {
    let mut w = world()?;
    assert_eq!(
        w.send(&[w.begin(0, 0), w.end(0, 1)]).err(),
        Some(engine_error_at(0, EngineError::FlashEndOrder))
    );
    w.env
        .create_intent(&w.trader, &w.market, &swap_spec(1, ESCROW)?)?;
    assert_eq!(
        w.send(&[w.begin(1, 2), w.begin(0, 0), w.end(1, 1), w.end(0, 1)])
            .err(),
        Some(engine_error_at(1, EngineError::FlashEndOrder))
    );
    Ok(())
}

#[test]
fn an_end_row_before_begin_cannot_satisfy_it() -> TestResult {
    let mut w = world()?;
    assert_eq!(
        w.send(&[w.end(0, 1), w.begin(0, 0)]).err(),
        Some(engine_error_at(0, EngineError::InvalidTransition))
    );
    Ok(())
}

#[test]
fn an_end_reached_through_cpi_does_not_release_the_top_level_end() -> TestResult {
    let mut w = world()?;
    let inner = relayed(intent_engine::ID, w.end(0, 1));
    assert_eq!(
        w.send(&[w.begin(0, 2), inner, w.end(0, 1)]).err(),
        Some(engine_error_at(2, EngineError::InvalidTransition))
    );
    assert_eq!(w.env.intent(&w.owner(), 0)?.status, Status::Open as u8);
    Ok(())
}

#[test]
fn only_the_real_instructions_sysvar_is_read() -> TestResult {
    let mut w = world()?;
    let mut begin = w.begin(0, 1);
    if let Some(meta) = begin
        .accounts
        .iter_mut()
        .find(|meta| meta.pubkey == solana_instructions_sysvar::ID)
    {
        meta.pubkey = Pubkey::new_unique();
    }
    assert_eq!(
        w.send(&[begin, w.end(0, 1)]).err(),
        Some(TransactionError::InstructionError(
            0,
            InstructionError::UnsupportedSysvar
        ))
    );
    Ok(())
}

#[test]
fn an_end_row_naming_no_accounts_is_rejected() -> TestResult {
    let mut w = world()?;
    let mut bare = w.end(0, 1);
    bare.accounts.clear();
    assert_eq!(
        w.send(&[w.begin(0, 1), bare]).err(),
        Some(engine_error_at(0, EngineError::FlashEndIntent))
    );
    Ok(())
}

#[test]
fn begin_requires_the_canonical_fee_account_and_none_at_zero_fee() -> TestResult {
    let mut w = world()?;
    let recipient = w.env.config()?.fee_recipient;
    let side =
        w.env
            .create_token_account(&w.market.input_mint, &recipient, w.market.input_program)?;
    let begin = w.env.begin_fill_ix(
        &w.solver.key.pubkey(),
        &w.owner(),
        &w.market,
        0,
        &w.solver.input,
        Some(&side),
        1,
    );
    assert_eq!(
        w.send(&[begin, w.end(0, 1)]).err(),
        Some(engine_error_at(0, EngineError::FeeAccountNotCanonical))
    );
    let authority = w.env.authority.insecure_clone();
    let mut settings = w.env.settings();
    settings.fee_bps = 0;
    let ix = w.env.update_config_ix(&authority.pubkey(), settings);
    w.env.send(&authority, &[ix], &[])?;
    let begin = w.env.begin_fill_ix(
        &w.solver.key.pubkey(),
        &w.owner(),
        &w.market,
        0,
        &w.solver.input,
        None,
        1,
    );
    w.send(&[begin, w.end(0, 1)])?;
    assert_eq!(w.env.balance(&w.solver.input)?, ESCROW);
    assert_eq!(w.env.balance(&w.fee_to)?, 0);
    Ok(())
}

#[test]
fn end_refuses_solver_funds_held_by_the_receivers_owner() -> TestResult {
    let mut w = world()?;
    let wallet = Keypair::new();
    w.trader.receiver = w.env.create_token_account(
        &w.market.output_mint,
        &wallet.pubkey(),
        w.market.output_program,
    )?;
    w.trader.receiver_authority = wallet.pubkey();
    w.env.mint_to(
        &w.market.input_mint,
        &w.trader.input,
        w.market.input_program,
        ESCROW,
    )?;
    w.env
        .create_intent(&w.trader, &w.market, &swap_spec(1, ESCROW)?)?;
    let held = w.env.create_token_account(
        &w.market.output_mint,
        &wallet.pubkey(),
        w.market.output_program,
    )?;
    let mut end = w.end(1, 1);
    if let Some(meta) = end.accounts.get_mut(4) {
        meta.pubkey = held;
    }
    assert_eq!(
        w.send(&[w.begin(1, 1), end]).err(),
        Some(engine_error_at(1, EngineError::SolverOutputNotAllowed))
    );
    Ok(())
}

#[test]
fn end_must_deliver_to_the_intents_receiver() -> TestResult {
    let mut w = world()?;
    let elsewhere = w.env.create_token_account(
        &w.market.output_mint,
        &Pubkey::new_unique(),
        w.market.output_program,
    )?;
    let mut end = w.end(0, 1);
    if let Some(meta) = end.accounts.get_mut(3) {
        meta.pubkey = elsewhere;
    }
    assert_eq!(
        w.send(&[w.begin(0, 1), end]).err(),
        Some(svm_tests::anchor_error_at(
            1,
            anchor_lang::error::ErrorCode::ConstraintHasOne
        ))
    );
    Ok(())
}

#[test]
fn a_failed_end_leaves_the_fee_account_untouched() -> TestResult {
    let mut w = world()?;
    let mut spec = swap_spec(1, ESCROW)?;
    spec.params = intent_core::kinds::swap_exact_in::Params {
        amount_in: ESCROW,
        min_out: 5,
    }
    .encode()
    .map_err(|e| format!("{e:?}"))?;
    w.env.mint_to(
        &w.market.input_mint,
        &w.trader.input,
        w.market.input_program,
        ESCROW,
    )?;
    w.env.create_intent(&w.trader, &w.market, &spec)?;
    assert_eq!(w.send(&[w.begin(1, 1), w.end(1, 4)]).err(), Some(engine_error_at(1, EngineError::InsufficientOutput)));
    assert_eq!(w.env.balance(&w.fee_to)?, 0);
    Ok(())
}

#[test]
fn a_dutch_auction_flash_fill_prices_at_the_transaction_time() -> TestResult {
    let mut w = world()?;
    let now = w.env.now();
    let spec = svm_tests::IntentSpec {
        nonce: 1,
        kind: intent_core::kinds::Kind::DutchAuction as u8,
        params: intent_core::kinds::dutch_auction::Params {
            amount_in: ESCROW,
            start_out: 1_000,
            end_out: 400,
            start_ts: now,
            end_ts: now + 100,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        expires_at: now + 200,
        flags: 0,
        ext: Vec::new(),
    };
    w.env.mint_to(
        &w.market.input_mint,
        &w.trader.input,
        w.market.input_program,
        ESCROW,
    )?;
    w.env.create_intent(&w.trader, &w.market, &spec)?;
    w.env.set_now(now + 50);
    assert_eq!(
        w.send(&[w.begin(1, 1), w.end(1, 699)]).err(),
        Some(engine_error_at(1, EngineError::InsufficientOutput))
    );
    let meta = w.send(&[w.begin(1, 1), w.end(1, 700)])?;
    assert_eq!(
        events::<FillEnded>(&meta).pop().map(|e| e.required),
        Some(700)
    );
    Ok(())
}

#[test]
fn a_flash_solver_bounds_the_fee_it_will_pay() -> TestResult {
    let mut w = world()?;
    let fee_bps = w.env.config()?.fee_bps;
    w.env.max_fee_bps = fee_bps - 1;
    assert_eq!(
        w.send(&[w.begin(0, 1), w.end(0, 1)]).err(),
        Some(engine_error_at(0, EngineError::FeeAboveBound))
    );
    w.env.max_fee_bps = fee_bps;
    w.send(&[w.begin(0, 1), w.end(0, 1)])?;
    Ok(())
}
