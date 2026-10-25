use intent_engine::errors::EngineError;
use solana_signer::Signer;
use svm_tests::{
    engine_error, intent_pda, swap_spec, vault_pda, Env, IntentSpec, TestResult, START_TS,
};

const FUNDED: u64 = 1_000;
const ESCROW: u64 = 300;
const EXPIRES: i64 = START_TS + 600;

fn spec(nonce: u64) -> TestResult<IntentSpec> {
    Ok(IntentSpec {
        expires_at: EXPIRES,
        ..swap_spec(nonce, ESCROW)?
    })
}

#[test]
fn catalog_econ_an_escrow_refunds_once_whichever_exit_comes_first() -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(anchor_spl::token::ID, &[], anchor_spl::token::ID, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let owner = trader.key.pubkey();
    let key = trader.key.insecure_clone();
    env.create_intent(&trader, &market, &spec(0)?)?;
    env.create_intent(&trader, &market, &spec(1)?)?;
    let left = FUNDED
        .checked_sub(ESCROW)
        .and_then(|l| l.checked_sub(ESCROW))
        .ok_or("funded covers both escrows")?;
    assert_eq!(env.balance(&trader.input)?, left);
    let cancel = env.cancel_ix(&owner, &market, 0, &trader.input);
    env.send(&key, &[cancel], &[])?;
    env.set_now(EXPIRES);
    let cranker = env.funded()?;
    let expire = env.expire_ix(&cranker.pubkey(), &owner, &market, 1, &trader.input);
    env.send(&cranker, &[expire], &[])?;
    assert_eq!(
        env.balance(&trader.input)?,
        FUNDED,
        "each escrow came back once"
    );
    let refused = Some(engine_error(EngineError::InvalidTransition));
    for nonce in [0u64, 1] {
        let expire = env.expire_ix(&cranker.pubkey(), &owner, &market, nonce, &trader.input);
        assert_eq!(
            env.send(&cranker, &[expire], &[]).err(),
            refused,
            "expire {nonce}"
        );
        let cancel = env.cancel_ix(&owner, &market, nonce, &trader.input);
        assert_eq!(
            env.send(&key, &[cancel], &[]).err(),
            refused,
            "cancel {nonce}"
        );
        let both = [
            env.cancel_ix(&owner, &market, nonce, &trader.input),
            env.expire_ix(&cranker.pubkey(), &owner, &market, nonce, &trader.input),
        ];
        assert!(
            env.send(&key, &both, &[&cranker]).is_err(),
            "cancel and expire {nonce}"
        );
        assert_eq!(env.balance(&vault_pda(&intent_pda(&owner, nonce)))?, 0);
    }
    assert_eq!(env.balance(&trader.input)?, FUNDED, "no exit refunds twice");
    for nonce in [0u64, 1] {
        let close = env.close_ix_by(&cranker.pubkey(), &owner, &market, nonce, &trader.input);
        env.send(&cranker, &[close], &[])?;
        assert!(!env.exists(&intent_pda(&owner, nonce)));
    }
    assert_eq!(
        env.balance(&trader.input)?,
        FUNDED,
        "closing sweeps nothing more"
    );
    Ok(())
}
