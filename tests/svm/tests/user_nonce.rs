use anchor_lang::error::ErrorCode;
use intent_core::mandate::MANDATE_NONCE_BIT;
use intent_core::nonce::{MAX_EPOCH_JUMP, MAX_NONCE_JUMP, NONCE_CEILING};
use intent_engine::errors::EngineError;
use intent_engine::state::USER_VERSION;
use solana_signer::Signer;
use svm_tests::{anchor_error, engine_error, user_pda, Env, TestResult};

#[test]
fn init_user_creates_empty_nonce_window_once() -> TestResult {
    let mut env = Env::new()?;
    let owner = env.funded()?;
    env.init_user(&owner)?;
    let u = env.user(&owner.pubkey())?;
    assert_eq!(u.owner, owner.pubkey());
    assert_eq!(u.nonce_base, 0);
    assert_eq!(u.nonce_bitmap, [0; 4]);
    assert_eq!(u.version, USER_VERSION);
    assert_eq!(
        u.bump,
        anchor_lang::prelude::Pubkey::find_program_address(
            &[b"user", owner.pubkey().as_ref()],
            &intent_engine::ID
        )
        .1
    );
    assert_eq!(
        env.init_user(&owner).err().map(|e| e.to_string()),
        Some("Error processing Instruction 0: custom program error: 0x0".to_owned())
    );
    Ok(())
}

#[test]
fn advance_nonce_only_moves_forward() -> TestResult {
    let mut env = Env::new()?;
    let owner = env.funded()?;
    env.init_user(&owner)?;
    let ix = env.advance_ix(&owner.pubkey(), 10);
    env.send(&owner, &[ix], &[])?;
    assert_eq!(env.user(&owner.pubkey())?.nonce_base, 10);
    for base in [10u64, 9, 0] {
        let ix = env.advance_ix(&owner.pubkey(), base);
        assert_eq!(
            env.send(&owner, &[ix], &[]).err(),
            Some(engine_error(EngineError::NonceRegression))
        );
    }
    Ok(())
}

#[test]
fn no_single_signature_can_use_up_an_owners_nonces_or_epochs() -> TestResult {
    let mut env = Env::new()?;
    let owner = env.funded()?;
    env.init_user(&owner)?;
    let too_far = [u64::MAX, MANDATE_NONCE_BIT, MAX_NONCE_JUMP + 1];
    for base in too_far {
        let ix = env.advance_ix(&owner.pubkey(), base);
        assert_eq!(
            env.send(&owner, &[ix], &[]).err(),
            Some(engine_error(EngineError::NonceJumpTooLarge)),
            "{base}"
        );
    }
    let ix = env.advance_ix(&owner.pubkey(), MAX_NONCE_JUMP);
    env.send(&owner, &[ix], &[])?;
    assert_eq!(env.user(&owner.pubkey())?.nonce_base, MAX_NONCE_JUMP);
    for epoch in [u64::MAX, MAX_EPOCH_JUMP + 1] {
        let ix = env.advance_epoch_ix(&owner.pubkey(), epoch);
        assert_eq!(
            env.send(&owner, &[ix], &[]).err(),
            Some(engine_error(EngineError::EpochJumpTooLarge)),
            "{epoch}"
        );
    }
    let ix = env.advance_epoch_ix(&owner.pubkey(), MAX_EPOCH_JUMP);
    env.send(&owner, &[ix], &[])?;
    assert_eq!(env.user(&owner.pubkey())?.epoch, MAX_EPOCH_JUMP);
    let ix = env.advance_epoch_ix(&owner.pubkey(), MAX_EPOCH_JUMP);
    assert_eq!(
        env.send(&owner, &[ix], &[]).err(),
        Some(engine_error(EngineError::EpochRegression))
    );
    Ok(())
}

#[test]
fn the_nonce_window_stops_below_the_agent_lanes() -> TestResult {
    let mut env = Env::new()?;
    let owner = env.funded()?;
    env.init_user(&owner)?;
    let user = user_pda(&owner.pubkey());
    let mut account = env.svm.get_account(&user).ok_or("user missing")?;
    let base = NONCE_CEILING - 10;
    account
        .data
        .get_mut(40..48)
        .ok_or("user state too short")?
        .copy_from_slice(&base.to_le_bytes());
    env.svm.set_account(user, account)?;
    assert_eq!(env.user(&owner.pubkey())?.nonce_base, base);
    let ix = env.advance_ix(&owner.pubkey(), NONCE_CEILING + 1);
    assert_eq!(
        env.send(&owner, &[ix], &[]).err(),
        Some(engine_error(EngineError::NonceJumpTooLarge))
    );
    let ix = env.advance_ix(&owner.pubkey(), NONCE_CEILING);
    env.send(&owner, &[ix], &[])?;
    assert_eq!(NONCE_CEILING, MANDATE_NONCE_BIT - 256);
    Ok(())
}

#[test]
fn nobody_else_can_advance_a_users_nonce() -> TestResult {
    let mut env = Env::new()?;
    let owner = env.funded()?;
    let stranger = env.funded()?;
    env.init_user(&owner)?;
    let mut ix = env.advance_ix(&stranger.pubkey(), 5);
    if let Some(meta) = ix.accounts.get_mut(1) {
        meta.pubkey = user_pda(&owner.pubkey());
    }
    assert_eq!(
        env.send(&stranger, &[ix], &[]).err(),
        Some(anchor_error(ErrorCode::ConstraintSeeds))
    );
    assert_eq!(env.user(&owner.pubkey())?.nonce_base, 0);
    Ok(())
}
