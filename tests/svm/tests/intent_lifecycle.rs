use anchor_lang::prelude::Pubkey;
use intent_core::lifecycle::Status;
use intent_engine::errors::EngineError;
use solana_signer::Signer;
use svm_tests::{
    bump_search_cost, engine_error, intent_pda, swap_spec, vault_pda, Env, Market, MintExt,
    TestResult, Trader,
};

const FUNDED: u64 = 1_000;
const ESCROW: u64 = 400;
const PROGRAMS: [Pubkey; 2] = [anchor_spl::token::ID, anchor_spl::token_2022::ID];

fn setup(program: Pubkey) -> TestResult<(Env, Market, Trader)> {
    let mut env = Env::new()?;
    env.init_config()?;
    let exts: &[MintExt] = if program == anchor_spl::token_2022::ID {
        &[MintExt::MetadataPointer]
    } else {
        &[]
    };
    let market = env.market(program, exts, program, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    Ok((env, market, trader))
}

#[test]
fn create_escrows_input_and_records_intent() -> TestResult {
    for program in PROGRAMS {
        let (mut env, market, trader) = setup(program)?;
        let spec = swap_spec(3, ESCROW)?;
        env.create_intent(&trader, &market, &spec)?;
        let owner = trader.key.pubkey();
        let intent = intent_pda(&owner, 3);
        assert_eq!(env.balance(&trader.input)?, FUNDED - ESCROW);
        assert_eq!(env.balance(&vault_pda(&intent))?, ESCROW);
        let i = env.intent(&owner, 3)?;
        assert_eq!(i.owner, owner);
        assert_eq!(i.input_mint, market.input_mint);
        assert_eq!(i.output_mint, market.output_mint);
        assert_eq!(i.receiver, trader.receiver);
        assert_eq!(i.nonce, 3);
        assert_eq!(i.escrowed, ESCROW);
        assert_eq!(i.created_at, env.now());
        assert_eq!(i.expires_at, spec.expires_at);
        assert_eq!(i.kind, spec.kind);
        assert_eq!(i.status, Status::Open as u8);
        assert_eq!(i.params, spec.params);
        assert_eq!(i.version, intent_engine::state::INTENT_VERSION);
        assert_eq!(
            i.bump,
            Pubkey::find_program_address(
                &[b"intent", owner.as_ref(), &3u64.to_le_bytes()],
                &intent_engine::ID
            )
            .1
        );
        assert_eq!(
            i.vault_bump,
            Pubkey::find_program_address(&[b"vault", intent.as_ref()], &intent_engine::ID).1
        );
        assert_eq!(env.user(&owner)?.nonce_bitmap, [0b1000, 0, 0, 0]);
    }
    Ok(())
}

#[test]
fn cancel_refunds_and_close_returns_all_rent() -> TestResult {
    for program in PROGRAMS {
        let (mut env, market, trader) = setup(program)?;
        env.create_intent(&trader, &market, &swap_spec(0, ESCROW)?)?;
        let owner = trader.key.pubkey();
        let intent = intent_pda(&owner, 0);
        let vault = vault_pda(&intent);
        let ix = env.cancel_ix(&owner, &market, 0, &trader.input);
        env.send(&trader.key, &[ix], &[])?;
        assert_eq!(env.balance(&trader.input)?, FUNDED);
        assert_eq!(env.balance(&vault)?, 0);
        assert_eq!(env.intent(&owner, 0)?.status, Status::Cancelled as u8);
        let ix = env.cancel_ix(&owner, &market, 0, &trader.input);
        assert_eq!(
            env.send(&trader.key, &[ix], &[]).err(),
            Some(engine_error(EngineError::InvalidTransition))
        );
        let rent = env.lamports(&intent).saturating_add(env.lamports(&vault));
        let before = env.lamports(&owner);
        let cranker = env.funded()?;
        let ix = env.close_ix_by(&cranker.pubkey(), &owner, &market, 0, &trader.input);
        let meta = env.send(&cranker, &[ix], &[])?;
        assert_eq!(svm_tests::token_transfers(&meta), 0);
        assert!(!env.exists(&intent));
        assert!(!env.exists(&vault));
        assert_eq!(env.lamports(&owner), before.saturating_add(rent));
    }
    Ok(())
}

#[test]
fn open_intent_cannot_be_closed() -> TestResult {
    let (mut env, market, trader) = setup(anchor_spl::token::ID)?;
    env.create_intent(&trader, &market, &swap_spec(0, ESCROW)?)?;
    let ix = env.close_ix(&trader.key.pubkey(), &market, 0, &trader.input);
    assert_eq!(
        env.send(&trader.key, &[ix], &[]).err(),
        Some(engine_error(EngineError::InvalidTransition))
    );
    assert!(env.exists(&intent_pda(&trader.key.pubkey(), 0)));
    Ok(())
}

#[test]
fn anyone_expires_exactly_at_expiry_and_refund_goes_to_owner() -> TestResult {
    for program in PROGRAMS {
        let (mut env, market, trader) = setup(program)?;
        let spec = swap_spec(1, ESCROW)?;
        env.create_intent(&trader, &market, &spec)?;
        let owner = trader.key.pubkey();
        let cranker = env.funded()?;
        env.set_now(spec.expires_at.saturating_sub(1));
        let ix = env.expire_ix(&cranker.pubkey(), &owner, &market, 1, &trader.input);
        assert_eq!(
            env.send(&cranker, &[ix], &[]).err(),
            Some(engine_error(EngineError::NotExpired))
        );
        env.set_now(spec.expires_at);
        let ix = env.expire_ix(&cranker.pubkey(), &owner, &market, 1, &trader.input);
        env.send(&cranker, &[ix], &[])?;
        assert_eq!(env.balance(&trader.input)?, FUNDED);
        assert_eq!(env.intent(&owner, 1)?.status, Status::Expired as u8);
        let ix = env.cancel_ix(&owner, &market, 1, &trader.input);
        assert_eq!(
            env.send(&trader.key, &[ix], &[]).err(),
            Some(engine_error(EngineError::InvalidTransition))
        );
        let ix = env.close_ix_by(&cranker.pubkey(), &owner, &market, 1, &trader.input);
        env.send(&cranker, &[ix], &[])?;
        assert!(!env.exists(&intent_pda(&owner, 1)));
    }
    Ok(())
}

#[test]
fn owner_can_cancel_after_expiry_passes() -> TestResult {
    let (mut env, market, trader) = setup(anchor_spl::token::ID)?;
    let spec = swap_spec(0, ESCROW)?;
    env.create_intent(&trader, &market, &spec)?;
    env.set_now(spec.expires_at.saturating_add(1_000));
    let ix = env.cancel_ix(&trader.key.pubkey(), &market, 0, &trader.input);
    env.send(&trader.key, &[ix], &[])?;
    assert_eq!(env.balance(&trader.input)?, FUNDED);
    Ok(())
}

#[test]
fn closed_intent_nonce_cannot_be_reused() -> TestResult {
    let (mut env, market, trader) = setup(anchor_spl::token::ID)?;
    let owner = trader.key.pubkey();
    env.create_intent(&trader, &market, &swap_spec(0, ESCROW)?)?;
    let cancel = env.cancel_ix(&owner, &market, 0, &trader.input);
    let close = env.close_ix(&owner, &market, 0, &trader.input);
    env.send(&trader.key, &[cancel, close], &[])?;
    assert!(!env.exists(&intent_pda(&owner, 0)));
    assert_eq!(
        env.create_intent(&trader, &market, &swap_spec(0, ESCROW)?)
            .err(),
        Some(engine_error(EngineError::NonceUsed))
    );
    env.create_intent(&trader, &market, &swap_spec(1, ESCROW)?)?;
    Ok(())
}

#[test]
fn nonce_must_lie_inside_window() -> TestResult {
    let (mut env, market, trader) = setup(anchor_spl::token::ID)?;
    let owner = trader.key.pubkey();
    assert_eq!(
        env.create_intent(&trader, &market, &swap_spec(256, 1)?)
            .err(),
        Some(engine_error(EngineError::NonceOutOfWindow))
    );
    env.create_intent(&trader, &market, &swap_spec(255, 1)?)?;
    let ix = env.advance_ix(&owner, 100);
    env.send(&trader.key, &[ix], &[])?;
    assert_eq!(
        env.create_intent(&trader, &market, &swap_spec(99, 1)?)
            .err(),
        Some(engine_error(EngineError::NonceUsed))
    );
    env.create_intent(&trader, &market, &swap_spec(355, 1)?)?;
    let user = env.user(&owner)?;
    assert_eq!(user.nonce_base, 100);
    assert_eq!(user.nonce_bitmap, [0, 0, 1 << 27, 1 << 63]);
    Ok(())
}

#[test]
fn donated_tokens_do_not_block_close() -> TestResult {
    for program in PROGRAMS {
        let (mut env, market, trader) = setup(program)?;
        let owner = trader.key.pubkey();
        env.create_intent(&trader, &market, &swap_spec(0, ESCROW)?)?;
        let ix = env.cancel_ix(&owner, &market, 0, &trader.input);
        env.send(&trader.key, &[ix], &[])?;
        let griefer = env.funded()?;
        let griefer_account =
            env.create_token_account(&market.input_mint, &griefer.pubkey(), program)?;
        env.mint_to(&market.input_mint, &griefer_account, program, 5)?;
        let vault = vault_pda(&intent_pda(&owner, 0));
        env.transfer(
            &griefer,
            &griefer_account,
            &market.input_mint,
            &vault,
            program,
            5,
        )?;
        let ix = env.close_ix_by(&griefer.pubkey(), &owner, &market, 0, &trader.input);
        let meta = env.send(&griefer, &[ix], &[])?;
        let closed = svm_tests::events::<intent_engine::events::IntentClosed>(&meta);
        assert_eq!(svm_tests::token_transfers(&meta), 1);
        assert_eq!(closed.first().map(|e| e.swept), Some(5));
        assert!(!env.exists(&vault));
        assert_eq!(env.balance(&trader.input)?, FUNDED + 5);
    }
    Ok(())
}

#[test]
fn cancel_expire_and_close_stay_within_measured_budgets() -> TestResult {
    let mut measured = Vec::new();
    for (program, suffix) in [
        (anchor_spl::token::ID, "spl"),
        (anchor_spl::token_2022::ID, "token_2022"),
    ] {
        let (mut env, market, trader) = setup(program)?;
        let owner = trader.key.pubkey();
        let ata_bump = Pubkey::find_program_address(
            &[owner.as_ref(), program.as_ref(), market.input_mint.as_ref()],
            &anchor_spl::associated_token::ID,
        )
        .1;
        let spec = swap_spec(0, ESCROW)?;
        env.create_intent(&trader, &market, &spec)?;
        env.create_intent(&trader, &market, &swap_spec(1, ESCROW)?)?;
        let cancel = env.cancel_ix(&owner, &market, 1, &trader.input);
        let cancelled = env.send(&trader.key, &[cancel], &[])?;
        measured.push((format!("cancel_{suffix}"), cancelled.compute_units_consumed));
        env.set_now(spec.expires_at);
        let cranker = env.funded()?;
        let expire = env.expire_ix(&cranker.pubkey(), &owner, &market, 0, &trader.input);
        let expired = env.send(&cranker, &[expire], &[])?;
        measured.push((
            format!("expire_{suffix}"),
            expired
                .compute_units_consumed
                .saturating_sub(bump_search_cost(ata_bump)),
        ));
        let close = env.close_ix_by(&cranker.pubkey(), &owner, &market, 0, &trader.input);
        let closed = env.send(&cranker, &[close], &[])?;
        measured.push((
            format!("close_{suffix}"),
            closed
                .compute_units_consumed
                .saturating_sub(bump_search_cost(ata_bump)),
        ));
    }
    svm_tests::cu_gates(&measured)
}
