use anchor_lang::prelude::Pubkey;
use core::mem::offset_of;
use intent_engine::errors::EngineError;
use intent_engine::state::Intent;
use solana_signer::Signer;
use svm_tests::{engine_error, intent_pda, swap_spec, vault_pda, Env, Market, TestResult, Trader};

const FUNDED: u64 = 1_000;
const ESCROW: u64 = 400;

const KIND_AT: usize = 8 + offset_of!(Intent, kind);
const PARAMS_AT: usize = 8 + offset_of!(Intent, params);

fn setup() -> TestResult<(Env, Market, Trader)> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(anchor_spl::token::ID, &[], anchor_spl::token::ID, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    Ok((env, market, trader))
}

fn poke(env: &mut Env, key: &Pubkey, at: usize, value: u8) -> TestResult {
    let mut account = env.svm.get_account(key).ok_or("account missing")?;
    *account.data.get_mut(at).ok_or("short")? = value;
    env.svm.set_account(*key, account)?;
    Ok(())
}

#[test]
fn a_live_intents_corrupted_kind_byte_is_refused_at_fill() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    env.create_intent(&trader, &market, &swap_spec(0, ESCROW)?)?;
    let intent = intent_pda(&owner, 0);
    let vault = vault_pda(&intent);
    poke(&mut env, &intent, KIND_AT, 7)?;
    assert_eq!(env.intent(&owner, 0)?.kind, 7);
    let solver = env.solver(&market, 0)?;
    let fee_to = env.fee_account(&market)?;
    let fill = env.fill_ix(
        &solver,
        &owner,
        &market,
        0,
        &trader.receiver,
        Some(&fee_to),
        ESCROW,
    );
    assert_eq!(
        env.send(&solver.key, &[fill], &[]),
        Err(engine_error(EngineError::UnknownKind))
    );
    assert_eq!(env.balance(&vault)?, ESCROW);
    assert!(env.exists(&intent));
    Ok(())
}

#[test]
fn a_live_intents_tampered_params_tail_is_refused_at_fill() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    env.create_intent(&trader, &market, &swap_spec(0, ESCROW)?)?;
    let intent = intent_pda(&owner, 0);
    let vault = vault_pda(&intent);
    poke(&mut env, &intent, PARAMS_AT + 100, 1)?;
    assert_eq!(env.intent(&owner, 0)?.kind, 1);
    let solver = env.solver(&market, 0)?;
    let fee_to = env.fee_account(&market)?;
    let fill = env.fill_ix(
        &solver,
        &owner,
        &market,
        0,
        &trader.receiver,
        Some(&fee_to),
        ESCROW,
    );
    assert_eq!(
        env.send(&solver.key, &[fill], &[]),
        Err(engine_error(EngineError::NonCanonical))
    );
    assert_eq!(env.balance(&vault)?, ESCROW);
    assert!(env.exists(&intent));
    Ok(())
}
