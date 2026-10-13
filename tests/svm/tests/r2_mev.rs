use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use intent_core::kinds::{swap_exact_in, Kind};
use intent_core::lifecycle::Status;
use intent_engine::errors::EngineError;
use intent_engine::events::IntentFilled;
use solana_signer::Signer;
use svm_tests::{
    anchor_error, engine_error, events, intent_pda, vault_pda, Env, IntentSpec, Market, TestResult,
    Trader, START_TS,
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
    fee_to: Pubkey,
}

fn world() -> TestResult<World> {
    let program = anchor_spl::token::ID;
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(program, &[], program, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let fee_to = env.fee_account(&market)?;
    Ok(World {
        env,
        market,
        trader,
        fee_to,
    })
}

impl World {
    fn owner(&self) -> Pubkey {
        self.trader.key.pubkey()
    }
}

#[test]
fn a_front_runner_who_steals_the_fill_still_pays_the_owners_receiver() -> TestResult {
    let mut w = world()?;
    w.env
        .create_intent(&w.trader, &w.market, &swap(0, ESCROW, MIN_OUT)?)?;

    let victim = w.env.solver(&w.market, SOLVER_FUNDS)?;
    let frontrunner = w.env.solver(&w.market, SOLVER_FUNDS)?;

    let ix = w.env.fill_ix(
        &frontrunner,
        &w.owner(),
        &w.market,
        0,
        &w.trader.receiver,
        Some(&w.fee_to),
        MIN_OUT,
    );
    let meta = w.env.send(&frontrunner.key, &[ix], &[])?;

    assert_eq!(
        w.env.balance(&w.trader.receiver)?,
        MIN_OUT,
        "the owner's bound receiver is paid the minimum, not the front-runner"
    );
    assert_eq!(
        w.env.balance(&frontrunner.output)?,
        SOLVER_FUNDS - MIN_OUT,
        "the front-runner spent its own output to win the fill"
    );
    assert_eq!(w.env.balance(&frontrunner.input)?, ESCROW - 1);
    assert_eq!(
        (
            w.env.balance(&victim.output)?,
            w.env.balance(&victim.input)?
        ),
        (SOLVER_FUNDS, 0),
        "the victim solver is untouched"
    );
    assert_eq!(w.env.balance(&vault_pda(&intent_pda(&w.owner(), 0)))?, 0);

    let e = events::<IntentFilled>(&meta).pop().ok_or("missing")?;
    assert_eq!(e.receiver, w.trader.receiver);
    assert_eq!(e.solver, frontrunner.key.pubkey());
    assert_eq!(
        (e.amount_in, e.delivered, e.required),
        (ESCROW, MIN_OUT, MIN_OUT)
    );

    assert_eq!(w.env.intent(&w.owner(), 0)?.status, Status::Filled as u8);
    let late = w.env.fill_ix(
        &victim,
        &w.owner(),
        &w.market,
        0,
        &w.trader.receiver,
        Some(&w.fee_to),
        MIN_OUT,
    );
    assert_eq!(
        w.env.send(&victim.key, &[late], &[]).err(),
        Some(engine_error(EngineError::InvalidTransition))
    );
    Ok(())
}

#[test]
fn a_front_runner_cannot_redirect_the_payout_to_its_own_receiver() -> TestResult {
    let mut w = world()?;
    w.env
        .create_intent(&w.trader, &w.market, &swap(0, ESCROW, MIN_OUT)?)?;
    let frontrunner = w.env.solver(&w.market, SOLVER_FUNDS)?;

    let stolen = w.env.create_token_account(
        &w.market.output_mint,
        &frontrunner.key.pubkey(),
        w.market.output_program,
    )?;
    let ix = w.env.fill_ix(
        &frontrunner,
        &w.owner(),
        &w.market,
        0,
        &stolen,
        Some(&w.fee_to),
        MIN_OUT,
    );
    assert_eq!(
        w.env.send(&frontrunner.key, &[ix], &[]).err(),
        Some(anchor_error(ErrorCode::ConstraintHasOne))
    );

    assert_eq!(w.env.balance(&stolen)?, 0);
    assert_eq!(w.env.balance(&w.trader.receiver)?, 0);
    assert_eq!(w.env.balance(&frontrunner.output)?, SOLVER_FUNDS);
    assert_eq!(
        w.env.balance(&vault_pda(&intent_pda(&w.owner(), 0)))?,
        ESCROW
    );
    assert_eq!(w.env.intent(&w.owner(), 0)?.status, Status::Open as u8);
    Ok(())
}
