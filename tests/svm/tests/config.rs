use anchor_lang::prelude::Pubkey;
use intent_engine::errors::EngineError;
use intent_engine::state::{CONFIG_VERSION, MAX_FEE_BPS, PAUSE_ALL, PAUSE_CREATE, PAUSE_FILL};
use solana_signer::Signer;
use svm_tests::{config_pda, engine_error, Env, TestResult};

#[test]
fn upgrade_authority_initializes_config_with_settings() -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let c = env.config()?;
    assert_eq!(c.admin, env.authority.pubkey());
    assert_eq!(c.pending_admin, Pubkey::default());
    assert_eq!(c.guardian, env.guardian.pubkey());
    assert_eq!(c.fee_recipient, env.fee_recipient);
    assert_eq!(c.enabled_kinds, intent_core::kinds::ALL_KINDS_MASK);
    assert_eq!(c.fee_bps, 5);
    assert_eq!(c.paused, 0);
    assert_eq!(c.version, CONFIG_VERSION);
    assert_eq!(
        c.bump,
        Pubkey::find_program_address(&[b"config"], &intent_engine::ID).1
    );
    Ok(())
}

#[test]
fn non_upgrade_authority_cannot_initialize_config() -> TestResult {
    let mut env = Env::new()?;
    let stranger = env.funded()?;
    let ix = env.init_config_ix(&stranger.pubkey(), env.settings());
    assert_eq!(
        env.send(&stranger, &[ix], &[]).err(),
        Some(engine_error(EngineError::Unauthorized))
    );
    assert!(!env.exists(&config_pda()));
    Ok(())
}

#[test]
fn the_upgrade_authority_of_another_program_cannot_initialize_config() -> TestResult {
    let mut env = Env::new()?;
    let stranger = env.funded()?;
    let foreign = Pubkey::new_unique();
    let mut account = env
        .svm
        .get_account(&svm_tests::program_data_address())
        .ok_or("program data missing")?;
    account
        .data
        .get_mut(13..45)
        .ok_or("program data too short")?
        .copy_from_slice(stranger.pubkey().as_ref());
    env.svm.set_account(foreign, account)?;
    let mut ix = env.init_config_ix(&stranger.pubkey(), env.settings());
    let slot = ix
        .accounts
        .iter_mut()
        .find(|m| m.pubkey == svm_tests::program_data_address())
        .ok_or("program data meta")?;
    slot.pubkey = foreign;
    assert_eq!(
        env.send(&stranger, &[ix], &[]).err(),
        Some(engine_error(EngineError::Unauthorized))
    );
    assert!(!env.exists(&config_pda()));
    Ok(())
}

#[test]
fn immutable_program_cannot_initialize_config() -> TestResult {
    let mut env = Env::new()?;
    env.set_upgrade_authority(None)?;
    let authority = env.authority.insecure_clone();
    let ix = env.init_config_ix(&authority.pubkey(), env.settings());
    assert_eq!(
        env.send(&authority, &[ix], &[]).err(),
        Some(engine_error(EngineError::Unauthorized))
    );
    Ok(())
}

#[test]
fn config_cannot_be_initialized_twice() -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let authority = env.authority.insecure_clone();
    let mut settings = env.settings();
    settings.fee_bps = 9;
    let ix = env.init_config_ix(&authority.pubkey(), settings);
    assert_eq!(
        env.send(&authority, &[ix], &[]),
        Err(
            solana_transaction_error::TransactionError::InstructionError(
                0,
                solana_instruction_error::InstructionError::Custom(0)
            )
        )
    );
    assert_eq!(env.config()?.fee_bps, 5);
    Ok(())
}

#[test]
fn init_config_rejects_out_of_range_settings() -> TestResult {
    let mut env = Env::new()?;
    let authority = env.authority.insecure_clone();
    let cases = [
        (
            MAX_FEE_BPS + 1,
            intent_core::kinds::ALL_KINDS_MASK,
            0,
            EngineError::FeeTooHigh,
        ),
        (0, 0b1, 0, EngineError::UnknownKindBits),
        (0, 0b10_0000, 0, EngineError::UnknownKindBits),
        (0, u64::MAX, 0, EngineError::UnknownKindBits),
        (0, 0, 0b100, EngineError::InvalidPauseFlags),
        (0, 0, u8::MAX, EngineError::InvalidPauseFlags),
    ];
    for (fee_bps, enabled_kinds, paused, err) in cases {
        let mut settings = env.settings();
        settings.fee_bps = fee_bps;
        settings.enabled_kinds = enabled_kinds;
        settings.paused = paused;
        let ix = env.init_config_ix(&authority.pubkey(), settings);
        assert_eq!(
            env.send(&authority, &[ix], &[]).err(),
            Some(engine_error(err))
        );
    }
    let mut settings = env.settings();
    settings.fee_bps = MAX_FEE_BPS;
    settings.paused = PAUSE_ALL;
    let ix = env.init_config_ix(&authority.pubkey(), settings);
    env.send(&authority, &[ix], &[])?;
    assert_eq!(env.config()?.fee_bps, MAX_FEE_BPS);
    assert_eq!(env.config()?.paused, PAUSE_ALL);
    Ok(())
}

#[test]
fn only_admin_updates_config() -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let stranger = env.funded()?;
    let guardian = env.guardian.insecure_clone();
    let authority = env.authority.insecure_clone();
    let mut settings = env.settings();
    settings.fee_bps = 42;
    settings.enabled_kinds = 0b100;
    settings.fee_recipient = Pubkey::new_unique();
    settings.guardian = Pubkey::new_unique();
    for who in [&stranger, &guardian] {
        let ix = env.update_config_ix(&who.pubkey(), settings);
        assert_eq!(
            env.send(who, &[ix], &[]).err(),
            Some(engine_error(EngineError::Unauthorized))
        );
    }
    let ix = env.update_config_ix(&authority.pubkey(), settings);
    env.send(&authority, &[ix], &[])?;
    let c = env.config()?;
    assert_eq!(c.fee_bps, 42);
    assert_eq!(c.enabled_kinds, 0b100);
    assert_eq!(c.paused, 0);
    assert_eq!(c.fee_recipient, settings.fee_recipient);
    assert_eq!(c.guardian, settings.guardian);
    assert_eq!(c.admin, authority.pubkey());
    settings.fee_bps = MAX_FEE_BPS + 1;
    let ix = env.update_config_ix(&authority.pubkey(), settings);
    assert_eq!(
        env.send(&authority, &[ix], &[]).err(),
        Some(engine_error(EngineError::FeeTooHigh))
    );
    Ok(())
}

#[test]
fn admin_handover_requires_proposal_and_acceptance() -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let authority = env.authority.insecure_clone();
    let next = env.funded()?;
    let stranger = env.funded()?;
    let ix = env.propose_admin_ix(&stranger.pubkey(), stranger.pubkey());
    assert_eq!(
        env.send(&stranger, &[ix], &[]).err(),
        Some(engine_error(EngineError::Unauthorized))
    );
    let ix = env.accept_admin_ix(&next.pubkey());
    assert_eq!(
        env.send(&next, &[ix], &[]).err(),
        Some(engine_error(EngineError::NotPendingAdmin))
    );
    let ix = env.propose_admin_ix(&authority.pubkey(), next.pubkey());
    env.send(&authority, &[ix], &[])?;
    assert_eq!(env.config()?.pending_admin, next.pubkey());
    assert_eq!(env.config()?.admin, authority.pubkey());
    let ix = env.accept_admin_ix(&stranger.pubkey());
    assert_eq!(
        env.send(&stranger, &[ix], &[]).err(),
        Some(engine_error(EngineError::NotPendingAdmin))
    );
    let ix = env.accept_admin_ix(&next.pubkey());
    env.send(&next, &[ix], &[])?;
    assert_eq!(env.config()?.admin, next.pubkey());
    assert_eq!(env.config()?.pending_admin, Pubkey::default());
    let ix = env.accept_admin_ix(&next.pubkey());
    assert_eq!(
        env.send(&next, &[ix], &[]).err(),
        Some(engine_error(EngineError::NotPendingAdmin))
    );
    let ix = env.update_config_ix(&authority.pubkey(), env.settings());
    assert_eq!(
        env.send(&authority, &[ix], &[]).err(),
        Some(engine_error(EngineError::Unauthorized))
    );
    let mut settings = env.settings();
    settings.fee_bps = 7;
    let ix = env.update_config_ix(&next.pubkey(), settings);
    env.send(&next, &[ix], &[])?;
    assert_eq!(env.config()?.fee_bps, 7);
    Ok(())
}

#[test]
fn guardian_and_admin_can_only_raise_pause_flags() -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let guardian = env.guardian.insecure_clone();
    let authority = env.authority.insecure_clone();
    let stranger = env.funded()?;
    let ix = env.raise_pause_ix(&stranger.pubkey(), PAUSE_CREATE);
    assert_eq!(
        env.send(&stranger, &[ix], &[]).err(),
        Some(engine_error(EngineError::Unauthorized))
    );
    for flags in [0u8, 0b100, u8::MAX] {
        let ix = env.raise_pause_ix(&guardian.pubkey(), flags);
        assert_eq!(
            env.send(&guardian, &[ix], &[]).err(),
            Some(engine_error(EngineError::InvalidPauseFlags))
        );
    }
    let ix = env.raise_pause_ix(&guardian.pubkey(), PAUSE_CREATE);
    env.send(&guardian, &[ix], &[])?;
    assert_eq!(env.config()?.paused, PAUSE_CREATE);
    let ix = env.raise_pause_ix(&guardian.pubkey(), PAUSE_CREATE);
    env.send(&guardian, &[ix], &[])?;
    assert_eq!(env.config()?.paused, PAUSE_CREATE);
    let ix = env.raise_pause_ix(&authority.pubkey(), PAUSE_FILL);
    env.send(&authority, &[ix], &[])?;
    assert_eq!(env.config()?.paused, PAUSE_ALL);
    let ix = env.update_config_ix(&guardian.pubkey(), env.settings());
    assert_eq!(
        env.send(&guardian, &[ix], &[]).err(),
        Some(engine_error(EngineError::Unauthorized))
    );
    let ix = env.update_config_ix(&authority.pubkey(), env.settings());
    env.send(&authority, &[ix], &[])?;
    assert_eq!(env.config()?.paused, PAUSE_ALL);
    Ok(())
}

#[test]
fn an_admin_update_signed_before_a_pause_cannot_lift_it() -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let guardian = env.guardian.insecure_clone();
    let authority = env.authority.insecure_clone();
    let mut stale = env.settings();
    stale.fee_bps = 9;
    let update = env.update_config_ix(&authority.pubkey(), stale);
    let pause = env.raise_pause_ix(&guardian.pubkey(), PAUSE_ALL);
    env.send(&guardian, &[pause], &[])?;
    env.send(&authority, &[update], &[])?;
    let c = env.config()?;
    assert_eq!((c.paused, c.fee_bps), (PAUSE_ALL, 9));
    Ok(())
}

#[test]
fn only_the_admin_lowers_pause_flags() -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let guardian = env.guardian.insecure_clone();
    let authority = env.authority.insecure_clone();
    let stranger = env.funded()?;
    let ix = env.raise_pause_ix(&guardian.pubkey(), PAUSE_ALL);
    env.send(&guardian, &[ix], &[])?;
    for who in [&stranger, &guardian] {
        let ix = env.lower_pause_ix(&who.pubkey(), PAUSE_ALL);
        assert_eq!(
            env.send(who, &[ix], &[]).err(),
            Some(engine_error(EngineError::Unauthorized))
        );
    }
    for flags in [0u8, 0b100, u8::MAX] {
        let ix = env.lower_pause_ix(&authority.pubkey(), flags);
        assert_eq!(
            env.send(&authority, &[ix], &[]).err(),
            Some(engine_error(EngineError::InvalidPauseFlags))
        );
    }
    let ix = env.lower_pause_ix(&authority.pubkey(), PAUSE_FILL);
    env.send(&authority, &[ix], &[])?;
    assert_eq!(env.config()?.paused, PAUSE_CREATE);
    let ix = env.lower_pause_ix(&authority.pubkey(), PAUSE_FILL);
    env.send(&authority, &[ix], &[])?;
    assert_eq!(env.config()?.paused, PAUSE_CREATE);
    let ix = env.lower_pause_ix(&authority.pubkey(), PAUSE_CREATE);
    env.send(&authority, &[ix], &[])?;
    assert_eq!(env.config()?.paused, 0);
    Ok(())
}

#[test]
fn config_refuses_an_all_zero_domain() -> TestResult {
    let mut env = Env::new()?;
    let authority = env.authority.insecure_clone();
    let mut ix = env.init_config_ix(&authority.pubkey(), env.settings());
    let len = ix.data.len();
    if let Some(domain) = ix.data.get_mut(len.saturating_sub(32)..) {
        domain.fill(0);
    }
    assert_eq!(
        env.send(&authority, &[ix], &[]).err(),
        Some(engine_error(EngineError::InvalidDomain))
    );
    assert!(!env.exists(&config_pda()));
    Ok(())
}
