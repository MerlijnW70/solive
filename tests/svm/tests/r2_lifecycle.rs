use intent_core::lifecycle::Status;
use intent_engine::errors::EngineError;
use solana_signer::Signer;
use svm_tests::{
    engine_error, engine_error_at, intent_pda, swap_spec, vault_pda, Env, Market, Solver,
    TestResult, Trader,
};

const FUNDED: u64 = 1_000;
const ESCROW: u64 = 400;
const SOLVER_FUNDS: u64 = 10_000;

fn setup() -> TestResult<(Env, Market, Trader, Solver)> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(anchor_spl::token::ID, &[], anchor_spl::token::ID, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let solver = env.solver(&market, SOLVER_FUNDS)?;
    Ok((env, market, trader, solver))
}

#[test]
fn refund_after_expiry_then_a_late_fill_cannot_double_spend() -> TestResult {
    let (mut env, market, trader, solver) = setup()?;
    let owner = trader.key.pubkey();
    let fee_to = env.fee_account(&market)?;
    let spec = swap_spec(0, ESCROW)?;
    env.create_intent(&trader, &market, &spec)?;
    let intent = intent_pda(&owner, 0);
    let vault = vault_pda(&intent);
    assert_eq!(env.balance(&vault)?, ESCROW);

    let cranker = env.funded()?;
    env.set_now(spec.expires_at);
    let expire = env.expire_ix(&cranker.pubkey(), &owner, &market, 0, &trader.input);
    env.send(&cranker, &[expire], &[])?;
    assert_eq!(env.intent(&owner, 0)?.status, Status::Expired as u8);
    assert_eq!(
        env.balance(&trader.input)?,
        FUNDED,
        "escrow refunded to owner"
    );
    assert_eq!(
        env.balance(&vault)?,
        0,
        "the vault is drained by the refund"
    );

    let late = env.fill_ix(
        &solver,
        &owner,
        &market,
        0,
        &trader.receiver,
        Some(&fee_to),
        1,
    );
    assert_eq!(
        env.send(&solver.key, &[late], &[]).err(),
        Some(engine_error(EngineError::InvalidTransition)),
        "a fill after an expiry is rejected, never a second payout from the drained vault"
    );
    assert_eq!(
        env.balance(&trader.input)?,
        FUNDED,
        "owner keeps the refund"
    );
    assert_eq!(env.balance(&vault)?, 0);
    assert_eq!(env.balance(&solver.input)?, 0, "the solver is paid nothing");
    assert_eq!(
        env.balance(&solver.output)?,
        SOLVER_FUNDS,
        "the solver delivers nothing"
    );
    assert_eq!(env.balance(&trader.receiver)?, 0);
    Ok(())
}

#[test]
fn expire_and_fill_in_one_transaction_at_the_boundary_is_rejected() -> TestResult {
    let (mut env, market, trader, solver) = setup()?;
    let owner = trader.key.pubkey();
    let fee_to = env.fee_account(&market)?;
    let spec = swap_spec(0, ESCROW)?;
    env.create_intent(&trader, &market, &spec)?;
    let intent = intent_pda(&owner, 0);
    let vault = vault_pda(&intent);
    env.set_now(spec.expires_at);

    let fill = |env: &Env| {
        env.fill_ix(
            &solver,
            &owner,
            &market,
            0,
            &trader.receiver,
            Some(&fee_to),
            1,
        )
    };

    let fill_first = fill(&env);
    let expire = env.expire_ix(&solver.key.pubkey(), &owner, &market, 0, &trader.input);
    assert_eq!(
        env.send(&solver.key, &[fill_first, expire.clone()], &[])
            .err(),
        Some(engine_error_at(0, EngineError::IntentExpired)),
        "at exactly expires_at a fill is already expired, so it cannot front-run the refund"
    );

    let fill_second = fill(&env);
    assert_eq!(
        env.send(&solver.key, &[expire, fill_second], &[]).err(),
        Some(engine_error_at(1, EngineError::InvalidTransition)),
        "expiring then filling in one transaction cannot both refund the owner and pay the solver"
    );

    assert_eq!(
        env.intent(&owner, 0)?.status,
        Status::Open as u8,
        "both rejected races revert, leaving the intent open and funded"
    );
    assert_eq!(env.balance(&vault)?, ESCROW);
    assert_eq!(env.balance(&trader.input)?, FUNDED - ESCROW);
    assert_eq!(env.balance(&solver.output)?, SOLVER_FUNDS);
    Ok(())
}
