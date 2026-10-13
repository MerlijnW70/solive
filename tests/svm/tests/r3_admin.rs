use anchor_lang::prelude::Pubkey;
use intent_engine::errors::EngineError;
use intent_engine::state::PAUSE_ALL;
use intent_engine::Economics;
use solana_signer::Signer;
use svm_tests::{engine_error, Env, TestResult};

#[test]
fn reproposing_admin_revokes_the_stale_candidate() -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let authority = env.authority.insecure_clone();
    let first = env.funded()?;
    let second = env.funded()?;

    let ix = env.propose_admin_ix(&authority.pubkey(), first.pubkey());
    env.send(&authority, &[ix], &[])?;
    assert_eq!(env.config()?.pending_admin, first.pubkey());

    let ix = env.propose_admin_ix(&authority.pubkey(), second.pubkey());
    env.send(&authority, &[ix], &[])?;
    assert_eq!(env.config()?.pending_admin, second.pubkey());

    let ix = env.accept_admin_ix(&first.pubkey());
    assert_eq!(
        env.send(&first, &[ix], &[]).err(),
        Some(engine_error(EngineError::NotPendingAdmin))
    );
    assert_eq!(env.config()?.admin, authority.pubkey());
    assert_eq!(env.config()?.pending_admin, second.pubkey());

    let ix = env.accept_admin_ix(&second.pubkey());
    env.send(&second, &[ix], &[])?;
    assert_eq!(env.config()?.admin, second.pubkey());
    assert_eq!(env.config()?.pending_admin, Pubkey::default());

    let ix = env.propose_admin_ix(&authority.pubkey(), authority.pubkey());
    assert_eq!(
        env.send(&authority, &[ix], &[]).err(),
        Some(engine_error(EngineError::Unauthorized))
    );
    let ix = env.accept_admin_ix(&first.pubkey());
    assert_eq!(
        env.send(&first, &[ix], &[]).err(),
        Some(engine_error(EngineError::NotPendingAdmin))
    );
    assert_eq!(env.config()?.admin, second.pubkey());
    Ok(())
}

#[test]
fn the_guardian_cannot_rotate_admin_or_move_economics() -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let authority = env.authority.insecure_clone();
    let guardian = env.guardian.insecure_clone();
    let candidate = env.funded()?;

    let ix = env.propose_admin_ix(&guardian.pubkey(), guardian.pubkey());
    assert_eq!(
        env.send(&guardian, &[ix], &[]).err(),
        Some(engine_error(EngineError::Unauthorized))
    );

    let ix = env.propose_admin_ix(&authority.pubkey(), candidate.pubkey());
    env.send(&authority, &[ix], &[])?;
    let ix = env.accept_admin_ix(&guardian.pubkey());
    assert_eq!(
        env.send(&guardian, &[ix], &[]).err(),
        Some(engine_error(EngineError::NotPendingAdmin))
    );

    let ix = env.economics_ix(
        &guardian.pubkey(),
        Economics {
            kind_fee_mask: 0,
            kind_fee_bps: [0; 4],
            partner_cut_bps: 0,
            crank_bounty: 0,
            create_fee: 0,
        },
    );
    assert_eq!(
        env.send(&guardian, &[ix], &[]).err(),
        Some(engine_error(EngineError::Unauthorized))
    );

    let ix = env.raise_pause_ix(&guardian.pubkey(), PAUSE_ALL);
    env.send(&guardian, &[ix], &[])?;
    let ix = env.lower_pause_ix(&guardian.pubkey(), PAUSE_ALL);
    assert_eq!(
        env.send(&guardian, &[ix], &[]).err(),
        Some(engine_error(EngineError::Unauthorized))
    );

    let c = env.config()?;
    assert_eq!(c.admin, authority.pubkey());
    assert_eq!(c.pending_admin, candidate.pubkey());
    assert_eq!(c.paused, PAUSE_ALL);
    Ok(())
}
