use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use intent_core::kinds::{dutch_auction, limit_order, swap_exact_in, Kind};
use intent_core::lifecycle::Status;
use intent_engine::errors::EngineError;
use intent_engine::events::{IntentClosed, IntentFilled};
use intent_engine::state::PAUSE_FILL;
use solana_signer::Signer;
use svm_tests::{
    anchor_error, bump_search_cost, cu_gates, engine_error, events, intent_pda, token_transfers,
    vault_pda, Env, IntentSpec, Market, MintExt, Solver, TestResult, Trader, START_TS,
};

const FUNDED: u64 = 1_000;
const ESCROW: u64 = 400;
const MIN_OUT: u64 = 300;
const SOLVER_FUNDS: u64 = 10_000;

fn swap(nonce: u64, amount_in: u64, min_out: u64) -> TestResult<IntentSpec> {
    Ok(IntentSpec {
        nonce,
        kind: Kind::SwapExactIn as u8,
        params: swap_exact_in::Params { amount_in, min_out }
            .encode()
            .map_err(|e| format!("{e:?}"))?,
        expires_at: START_TS.saturating_add(3_600),
        flags: 0,
        ext: Vec::new(),
    })
}

struct World {
    env: Env,
    market: Market,
    trader: Trader,
    solver: Solver,
    fee_to: Pubkey,
}

fn world(input_program: Pubkey, output_program: Pubkey) -> TestResult<World> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(input_program, &[], output_program, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let solver = env.solver(&market, SOLVER_FUNDS)?;
    let fee_to = env.fee_account(&market)?;
    Ok(World {
        env,
        market,
        trader,
        solver,
        fee_to,
    })
}

fn spl() -> TestResult<World> {
    world(anchor_spl::token::ID, anchor_spl::token::ID)
}

impl World {
    fn owner(&self) -> Pubkey {
        self.trader.key.pubkey()
    }

    fn fill(
        &mut self,
        nonce: u64,
        amount_out: u64,
    ) -> Result<litesvm::types::TransactionMetadata, solana_transaction_error::TransactionError>
    {
        let ix = self.env.fill_ix(
            &self.solver,
            &self.owner(),
            &self.market,
            nonce,
            &self.trader.receiver,
            Some(&self.fee_to),
            amount_out,
        );
        let key = self.solver.key.insecure_clone();
        self.env.send(&key, &[ix], &[])
    }
}

#[test]
fn fill_delivers_output_pays_solver_and_fee_for_every_token_program_pair() -> TestResult {
    let programs = [anchor_spl::token::ID, anchor_spl::token_2022::ID];
    for input in programs {
        for output in programs {
            let mut w = world(input, output)?;
            w.env
                .create_intent(&w.trader, &w.market, &swap(0, ESCROW, MIN_OUT)?)?;
            let meta = w.fill(0, 350)?;
            assert_eq!(w.env.balance(&w.trader.receiver)?, 350);
            assert_eq!(w.env.balance(&w.solver.output)?, SOLVER_FUNDS - 350);
            assert_eq!(w.env.balance(&w.solver.input)?, ESCROW - 1);
            assert_eq!(w.env.balance(&w.fee_to)?, 1);
            assert_eq!(w.env.balance(&vault_pda(&intent_pda(&w.owner(), 0)))?, 0);
            assert_eq!(w.env.intent(&w.owner(), 0)?.status, Status::Filled as u8);
            assert_eq!(token_transfers(&meta), 3);
            let e = events::<IntentFilled>(&meta).pop().ok_or("missing")?;
            assert_eq!(e.intent, intent_pda(&w.owner(), 0));
            assert_eq!(e.owner, w.owner());
            assert_eq!(e.solver, w.solver.key.pubkey());
            assert_eq!(e.receiver, w.trader.receiver);
            assert_eq!(e.solver_input, w.solver.input);
            assert_eq!(e.net, ESCROW - 1);
            assert_eq!(
                (e.amount_in, e.delivered, e.required, e.fee),
                (ESCROW, 350, MIN_OUT, 1)
            );
            let cranker = w.env.funded()?;
            let ix =
                w.env
                    .close_ix_by(&cranker.pubkey(), &w.owner(), &w.market, 0, &w.trader.input);
            let meta = w.env.send(&cranker, &[ix], &[])?;
            let closed = events::<IntentClosed>(&meta).pop().ok_or("missing")?;
            assert_eq!(closed.swept, 0);
            assert!(!w.env.exists(&intent_pda(&w.owner(), 0)));
        }
    }
    Ok(())
}

#[test]
fn output_must_reach_the_minimum_exactly() -> TestResult {
    let mut w = spl()?;
    w.env
        .create_intent(&w.trader, &w.market, &swap(0, ESCROW, MIN_OUT)?)?;
    assert_eq!(
        w.fill(0, MIN_OUT - 1).err(),
        Some(engine_error(EngineError::InsufficientOutput))
    );
    assert_eq!(w.env.intent(&w.owner(), 0)?.status, Status::Open as u8);
    assert_eq!(w.env.balance(&w.solver.output)?, SOLVER_FUNDS);
    w.fill(0, MIN_OUT)?;
    assert_eq!(w.env.balance(&w.trader.receiver)?, MIN_OUT);
    Ok(())
}

#[test]
fn fill_is_allowed_until_the_second_before_expiry() -> TestResult {
    let mut w = spl()?;
    let spec = swap(0, ESCROW, MIN_OUT)?;
    w.env.create_intent(&w.trader, &w.market, &spec)?;
    w.env
        .create_intent(&w.trader, &w.market, &swap(1, ESCROW / 2, MIN_OUT)?)?;
    w.env.set_now(spec.expires_at);
    assert_eq!(
        w.fill(0, MIN_OUT).err(),
        Some(engine_error(EngineError::IntentExpired))
    );
    w.env.set_now(spec.expires_at - 1);
    w.fill(1, MIN_OUT)?;
    Ok(())
}

#[test]
fn only_open_intents_fill_and_only_once() -> TestResult {
    let mut w = spl()?;
    w.env
        .create_intent(&w.trader, &w.market, &swap(0, ESCROW / 2, MIN_OUT)?)?;
    w.env
        .create_intent(&w.trader, &w.market, &swap(1, ESCROW / 2, MIN_OUT)?)?;
    w.fill(0, MIN_OUT)?;
    assert_eq!(
        w.fill(0, MIN_OUT).err(),
        Some(engine_error(EngineError::InvalidTransition))
    );
    let ix = w.env.cancel_ix(&w.owner(), &w.market, 1, &w.trader.input);
    w.env.send(&w.trader.key, &[ix], &[])?;
    assert_eq!(
        w.fill(1, MIN_OUT).err(),
        Some(engine_error(EngineError::InvalidTransition))
    );
    Ok(())
}

#[test]
fn pause_blocks_fills_but_disabling_a_kind_does_not() -> TestResult {
    let mut w = spl()?;
    w.env
        .create_intent(&w.trader, &w.market, &swap(0, ESCROW, MIN_OUT)?)?;
    let authority = w.env.authority.insecure_clone();
    let ix = w.env.raise_pause_ix(&authority.pubkey(), PAUSE_FILL);
    w.env.send(&authority, &[ix], &[])?;
    assert_eq!(
        w.fill(0, MIN_OUT).err(),
        Some(engine_error(EngineError::FillPaused))
    );
    let ix = w.env.lower_pause_ix(&authority.pubkey(), PAUSE_FILL);
    w.env.send(&authority, &[ix], &[])?;
    let mut settings = w.env.settings();
    settings.enabled_kinds = Kind::LimitOrder.bit();
    let ix = w.env.update_config_ix(&authority.pubkey(), settings);
    w.env.send(&authority, &[ix], &[])?;
    w.fill(0, MIN_OUT)?;
    Ok(())
}

#[test]
fn solver_cannot_pay_from_accounts_of_the_owner_or_receiver_owner() -> TestResult {
    let mut w = spl()?;
    let wallet = w.env.funded()?;
    let mut trader = Trader {
        key: w.trader.key.insecure_clone(),
        input: w.trader.input,
        receiver: w.env.create_token_account(
            &w.market.output_mint,
            &wallet.pubkey(),
            w.market.output_program,
        )?,
        receiver_authority: wallet.pubkey(),
    };
    w.env
        .create_intent(&trader, &w.market, &swap(0, ESCROW, MIN_OUT)?)?;
    for (who, holder) in [(&w.trader.key, w.owner()), (&wallet, wallet.pubkey())] {
        let source =
            w.env
                .create_token_account(&w.market.output_mint, &holder, w.market.output_program)?;
        w.env.mint_to(
            &w.market.output_mint,
            &source,
            w.market.output_program,
            MIN_OUT,
        )?;
        let paying = Solver {
            key: who.insecure_clone(),
            output: source,
            input: w.solver.input,
        };
        let ix = w.env.fill_ix(
            &paying,
            &w.owner(),
            &w.market,
            0,
            &trader.receiver,
            Some(&w.fee_to),
            MIN_OUT,
        );
        assert_eq!(
            w.env.send(who, &[ix], &[]).err(),
            Some(engine_error(EngineError::SolverOutputNotAllowed))
        );
    }
    trader.key = w.trader.key.insecure_clone();
    let ix = w.env.fill_ix(
        &w.solver,
        &w.owner(),
        &w.market,
        0,
        &trader.receiver,
        Some(&w.fee_to),
        MIN_OUT,
    );
    w.env.send(&w.solver.key, &[ix], &[])?;
    assert_eq!(w.env.balance(&trader.receiver)?, MIN_OUT);
    Ok(())
}

#[test]
fn receiver_must_be_the_one_the_intent_named() -> TestResult {
    let mut w = spl()?;
    w.env
        .create_intent(&w.trader, &w.market, &swap(0, ESCROW, MIN_OUT)?)?;
    let elsewhere = w.env.create_token_account(
        &w.market.output_mint,
        &w.solver.key.pubkey(),
        w.market.output_program,
    )?;
    let ix = w.env.fill_ix(
        &w.solver,
        &w.owner(),
        &w.market,
        0,
        &elsewhere,
        Some(&w.fee_to),
        MIN_OUT,
    );
    assert_eq!(
        w.env.send(&w.solver.key, &[ix], &[]).err(),
        Some(anchor_error(ErrorCode::ConstraintHasOne))
    );
    Ok(())
}

#[test]
fn fee_must_go_to_the_fee_recipients_canonical_account() -> TestResult {
    let mut w = spl()?;
    w.env
        .create_intent(&w.trader, &w.market, &swap(0, ESCROW, MIN_OUT)?)?;
    let recipient = w.env.config()?.fee_recipient;
    let side =
        w.env
            .create_token_account(&w.market.input_mint, &recipient, w.market.input_program)?;
    let ix = w.env.fill_ix(
        &w.solver,
        &w.owner(),
        &w.market,
        0,
        &w.trader.receiver,
        Some(&side),
        MIN_OUT,
    );
    assert_eq!(
        w.env.send(&w.solver.key, &[ix], &[]).err(),
        Some(engine_error(EngineError::FeeAccountNotCanonical))
    );
    Ok(())
}

#[test]
fn zero_fee_skips_the_fee_transfer() -> TestResult {
    let mut w = spl()?;
    let authority = w.env.authority.insecure_clone();
    let mut settings = w.env.settings();
    settings.fee_bps = 0;
    let ix = w.env.update_config_ix(&authority.pubkey(), settings);
    w.env.send(&authority, &[ix], &[])?;
    w.env
        .create_intent(&w.trader, &w.market, &swap(0, ESCROW, MIN_OUT)?)?;
    let meta = w.fill(0, MIN_OUT)?;
    assert_eq!(token_transfers(&meta), 2);
    assert_eq!(w.env.balance(&w.fee_to)?, 0);
    assert_eq!(w.env.balance(&w.solver.input)?, ESCROW);
    Ok(())
}

#[test]
fn maximum_fee_rounds_up_against_the_solver() -> TestResult {
    let mut w = spl()?;
    let authority = w.env.authority.insecure_clone();
    let mut settings = w.env.settings();
    settings.fee_bps = intent_engine::state::MAX_FEE_BPS;
    let ix = w.env.update_config_ix(&authority.pubkey(), settings);
    w.env.send(&authority, &[ix], &[])?;
    w.env
        .create_intent(&w.trader, &w.market, &swap(0, 101, MIN_OUT)?)?;
    w.fill(0, MIN_OUT)?;
    assert_eq!(w.env.balance(&w.fee_to)?, 2);
    assert_eq!(w.env.balance(&w.solver.input)?, 99);
    Ok(())
}

#[test]
fn a_dust_escrow_pays_only_the_fee_and_moves_nothing_else() -> TestResult {
    let mut w = spl()?;
    w.env
        .create_intent(&w.trader, &w.market, &swap(0, 1, MIN_OUT)?)?;
    let meta = w.fill(0, MIN_OUT)?;
    assert_eq!(w.env.balance(&w.fee_to)?, 1);
    assert_eq!(w.env.balance(&w.solver.input)?, 0);
    assert_eq!(token_transfers(&meta), 2);
    Ok(())
}

#[test]
fn donated_vault_tokens_return_to_owner_not_solver() -> TestResult {
    let mut w = spl()?;
    w.env
        .create_intent(&w.trader, &w.market, &swap(0, ESCROW, MIN_OUT)?)?;
    let vault = vault_pda(&intent_pda(&w.owner(), 0));
    w.env
        .mint_to(&w.market.input_mint, &vault, w.market.input_program, 7)?;
    w.fill(0, MIN_OUT)?;
    assert_eq!(w.env.balance(&w.solver.input)?, ESCROW - 1);
    assert_eq!(w.env.balance(&vault)?, 7);
    let ix = w.env.close_ix(&w.owner(), &w.market, 0, &w.trader.input);
    let meta = w.env.send(&w.trader.key, &[ix], &[])?;
    assert_eq!(
        events::<IntentClosed>(&meta).pop().map(|e| e.swept),
        Some(7)
    );
    assert_eq!(w.env.balance(&w.trader.input)?, FUNDED - ESCROW + 7);
    Ok(())
}

#[test]
fn dutch_auction_requires_the_decayed_price_at_fill_time() -> TestResult {
    let mut w = spl()?;
    let start = w.env.now();
    let params = dutch_auction::Params {
        amount_in: ESCROW,
        start_out: 1_000,
        end_out: 400,
        start_ts: start,
        end_ts: start + 100,
    }
    .encode()
    .map_err(|e| format!("{e:?}"))?;
    let spec = IntentSpec {
        nonce: 0,
        kind: Kind::DutchAuction as u8,
        params,
        expires_at: start + 200,
        flags: 0,
        ext: Vec::new(),
    };
    w.env.create_intent(&w.trader, &w.market, &spec)?;
    w.env.set_now(start + 50);
    assert_eq!(
        w.fill(0, 699).err(),
        Some(engine_error(EngineError::InsufficientOutput))
    );
    let meta = w.fill(0, 700)?;
    assert_eq!(
        events::<IntentFilled>(&meta).pop().map(|e| e.required),
        Some(700)
    );
    Ok(())
}

#[test]
fn limit_order_requires_its_full_price_for_the_whole_escrow() -> TestResult {
    let mut w = spl()?;
    let params = limit_order::Params {
        make_amount: ESCROW,
        take_amount: 1_201,
    }
    .encode()
    .map_err(|e| format!("{e:?}"))?;
    let spec = IntentSpec {
        nonce: 0,
        kind: Kind::LimitOrder as u8,
        params,
        expires_at: START_TS.saturating_add(3_600),
        flags: 0,
        ext: Vec::new(),
    };
    w.env.create_intent(&w.trader, &w.market, &spec)?;
    assert_eq!(
        w.fill(0, 1_200).err(),
        Some(engine_error(EngineError::InsufficientOutput))
    );
    w.fill(0, 1_201)?;
    assert_eq!(w.env.balance(&w.solver.input)?, ESCROW - 1);
    Ok(())
}

#[test]
fn mints_are_rechecked_against_policy_at_fill() -> TestResult {
    let t22 = anchor_spl::token_2022::ID;
    for side in [0usize, 1] {
        let mut w = world(t22, t22)?;
        w.env
            .create_intent(&w.trader, &w.market, &swap(0, ESCROW, MIN_OUT)?)?;
        let hooked = w.env.create_mint(t22, &[MintExt::TransferHook])?;
        let forged = w.env.svm.get_account(&hooked).ok_or("mint missing")?;
        let target = if side == 0 {
            w.market.input_mint
        } else {
            w.market.output_mint
        };
        w.env.svm.set_account(target, forged)?;
        assert_eq!(
            w.fill(0, MIN_OUT).err(),
            Some(engine_error(EngineError::MintNotAllowed)),
            "side {side}"
        );
    }
    Ok(())
}

#[test]
fn create_and_fill_compute_stay_within_measured_budgets() -> TestResult {
    let budgets = [
        (anchor_spl::token::ID, "create_spl", "fill_spl"),
        (
            anchor_spl::token_2022::ID,
            "create_token_2022",
            "fill_token_2022",
        ),
    ];
    let mut measured = Vec::new();
    for (program, create_name, fill_name) in budgets {
        let mut w = world(program, program)?;
        let created = w
            .env
            .create_intent(&w.trader, &w.market, &swap(0, ESCROW, MIN_OUT)?)?;
        let filled = w.fill(0, MIN_OUT)?;
        let intent = w.env.intent(&w.owner(), 0)?;
        let fee_bump = Pubkey::find_program_address(
            &[
                w.env.config()?.fee_recipient.as_ref(),
                program.as_ref(),
                w.market.input_mint.as_ref(),
            ],
            &anchor_spl::associated_token::ID,
        )
        .1;
        let create_cu = created
            .compute_units_consumed
            .saturating_sub(bump_search_cost(intent.bump))
            .saturating_sub(bump_search_cost(intent.vault_bump));
        let fill_cu = filled
            .compute_units_consumed
            .saturating_sub(bump_search_cost(fee_bump));
        measured.push((create_name.to_owned(), create_cu));
        measured.push((fill_name.to_owned(), fill_cu));
    }
    cu_gates(&measured)
}

#[test]
fn prefunded_receiver_counts_only_the_new_delivery() -> TestResult {
    let mut w = spl()?;
    w.env
        .create_intent(&w.trader, &w.market, &swap(0, ESCROW, MIN_OUT)?)?;
    w.env.mint_to(
        &w.market.output_mint,
        &w.trader.receiver,
        w.market.output_program,
        5_000,
    )?;
    assert_eq!(
        w.fill(0, MIN_OUT - 1).err(),
        Some(engine_error(EngineError::InsufficientOutput))
    );
    let meta = w.fill(0, 350)?;
    assert_eq!(
        events::<IntentFilled>(&meta).pop().map(|e| e.delivered),
        Some(350)
    );
    assert_eq!(w.env.balance(&w.trader.receiver)?, 5_350);
    Ok(())
}

#[test]
fn create_pause_alone_does_not_block_fills() -> TestResult {
    let mut w = spl()?;
    w.env
        .create_intent(&w.trader, &w.market, &swap(0, ESCROW, MIN_OUT)?)?;
    let guardian = w.env.guardian.insecure_clone();
    let ix = w
        .env
        .raise_pause_ix(&guardian.pubkey(), intent_engine::state::PAUSE_CREATE);
    w.env.send(&guardian, &[ix], &[])?;
    w.fill(0, MIN_OUT)?;
    Ok(())
}

#[test]
fn fee_account_is_needed_only_when_a_fee_is_charged() -> TestResult {
    let mut w = spl()?;
    w.env
        .create_intent(&w.trader, &w.market, &swap(0, ESCROW / 2, MIN_OUT)?)?;
    w.env
        .create_intent(&w.trader, &w.market, &swap(1, ESCROW / 2, MIN_OUT)?)?;
    let ix = w.env.fill_ix(
        &w.solver,
        &w.owner(),
        &w.market,
        0,
        &w.trader.receiver,
        None,
        MIN_OUT,
    );
    assert_eq!(
        w.env.send(&w.solver.key, &[ix], &[]).err(),
        Some(engine_error(EngineError::FeeAccountMissing))
    );
    let authority = w.env.authority.insecure_clone();
    let mut settings = w.env.settings();
    settings.fee_bps = 0;
    let ix = w.env.update_config_ix(&authority.pubkey(), settings);
    w.env.send(&authority, &[ix], &[])?;
    let ix = w.env.fill_ix(
        &w.solver,
        &w.owner(),
        &w.market,
        1,
        &w.trader.receiver,
        None,
        MIN_OUT,
    );
    w.env.send(&w.solver.key, &[ix], &[])?;
    assert_eq!(w.env.balance(&w.solver.input)?, ESCROW / 2);
    Ok(())
}

#[test]
fn dutch_auction_holds_start_price_before_and_end_price_after_its_window() -> TestResult {
    let mut w = spl()?;
    let now = w.env.now();
    let params = dutch_auction::Params {
        amount_in: ESCROW / 2,
        start_out: 1_000,
        end_out: 400,
        start_ts: now + 10,
        end_ts: now + 110,
    }
    .encode()
    .map_err(|e| format!("{e:?}"))?;
    for nonce in [0u64, 1] {
        let spec = IntentSpec {
            nonce,
            kind: Kind::DutchAuction as u8,
            params,
            expires_at: now + 500,
            flags: 0,
            ext: Vec::new(),
        };
        w.env.create_intent(&w.trader, &w.market, &spec)?;
    }
    assert_eq!(
        w.fill(0, 999).err(),
        Some(engine_error(EngineError::InsufficientOutput))
    );
    w.fill(0, 1_000)?;
    w.env.set_now(now + 300);
    assert_eq!(
        w.fill(1, 399).err(),
        Some(engine_error(EngineError::InsufficientOutput))
    );
    w.fill(1, 400)?;
    Ok(())
}

#[test]
fn solver_paying_itself_into_the_vault_only_feeds_the_owner_sweep() -> TestResult {
    let mut w = spl()?;
    w.env
        .create_intent(&w.trader, &w.market, &swap(0, ESCROW, MIN_OUT)?)?;
    let vault = vault_pda(&intent_pda(&w.owner(), 0));
    w.solver.input = vault;
    w.fill(0, MIN_OUT)?;
    assert_eq!(w.env.balance(&vault)?, ESCROW - 1);
    let ix = w.env.close_ix(&w.owner(), &w.market, 0, &w.trader.input);
    w.env.send(&w.trader.key, &[ix], &[])?;
    assert_eq!(w.env.balance(&w.trader.input)?, FUNDED - 1);
    Ok(())
}

#[test]
fn a_solver_bounds_the_fee_it_will_pay_on_every_fill_path() -> TestResult {
    let mut w = spl()?;
    w.env
        .create_intent(&w.trader, &w.market, &swap(0, ESCROW, MIN_OUT)?)?;
    let fee_bps = w.env.config()?.fee_bps;
    w.env.max_fee_bps = fee_bps - 1;
    assert_eq!(
        w.fill(0, MIN_OUT).err(),
        Some(engine_error(EngineError::FeeAboveBound))
    );
    w.env.max_fee_bps = fee_bps;
    w.fill(0, MIN_OUT)?;
    assert_eq!(w.env.balance(&w.solver.input)?, ESCROW - 1);
    Ok(())
}
