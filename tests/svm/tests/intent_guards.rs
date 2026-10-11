use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use intent_engine::errors::EngineError;
use intent_engine::state::PAUSE_CREATE;
use solana_signer::Signer;
use svm_tests::{
    anchor_error, config_pda, engine_error, intent_pda, swap_spec, user_pda, vault_pda, Env,
    Market, MintExt, TestResult, Trader,
};

const FUNDED: u64 = 1_000;

fn setup() -> TestResult<(Env, Market, Trader)> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(anchor_spl::token::ID, &[], anchor_spl::token::ID, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    Ok((env, market, trader))
}

#[test]
fn pause_blocks_create_but_never_cancel_or_close() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    env.create_intent(&trader, &market, &swap_spec(0, 10)?)?;
    let guardian = env.guardian.insecure_clone();
    let ix = env.raise_pause_ix(&guardian.pubkey(), PAUSE_CREATE);
    env.send(&guardian, &[ix], &[])?;
    assert_eq!(
        env.create_intent(&trader, &market, &swap_spec(1, 10)?)
            .err(),
        Some(engine_error(EngineError::CreatePaused))
    );
    let cancel = env.cancel_ix(&owner, &market, 0, &trader.input);
    let close = env.close_ix(&owner, &market, 0, &trader.input);
    env.send(&trader.key, &[cancel, close], &[])?;
    assert_eq!(env.balance(&trader.input)?, FUNDED);
    Ok(())
}

#[test]
fn disabled_kind_is_rejected() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let authority = env.authority.insecure_clone();
    let mut settings = env.settings();
    settings.enabled_kinds = intent_core::kinds::Kind::LimitOrder.bit();
    let ix = env.update_config_ix(&authority.pubkey(), settings);
    env.send(&authority, &[ix], &[])?;
    assert_eq!(
        env.create_intent(&trader, &market, &swap_spec(0, 10)?)
            .err(),
        Some(engine_error(EngineError::KindDisabled))
    );
    Ok(())
}

#[test]
fn malformed_intents_are_rejected() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let mut unknown = swap_spec(0, 10)?;
    unknown.kind = 9;
    let mut zero = swap_spec(0, 10)?;
    zero.params = [0; intent_core::PARAMS_LEN];
    let mut trailing = swap_spec(0, 10)?;
    if let Some(b) = trailing.params.get_mut(100) {
        *b = 1;
    }
    let mut stale = swap_spec(0, 10)?;
    stale.expires_at = env.now();
    let cases = [
        (unknown, EngineError::UnknownKind),
        (zero, EngineError::InvalidParams),
        (trailing, EngineError::NonCanonical),
        (stale, EngineError::ExpiryNotInFuture),
    ];
    for (spec, err) in cases {
        assert_eq!(
            env.create_intent(&trader, &market, &spec).err(),
            Some(engine_error(err))
        );
    }
    let mut ok = swap_spec(0, 10)?;
    ok.expires_at = env.now().saturating_add(1);
    env.create_intent(&trader, &market, &ok)?;
    Ok(())
}

#[test]
fn escrow_larger_than_balance_fails_atomically() -> TestResult {
    let (mut env, market, trader) = setup()?;
    assert_eq!(
        env.create_intent(&trader, &market, &swap_spec(0, FUNDED + 1)?),
        Err(
            solana_transaction_error::TransactionError::InstructionError(
                0,
                solana_instruction_error::InstructionError::Custom(
                    anchor_spl::token_2022::spl_token_2022::error::TokenError::InsufficientFunds
                        as u32
                )
            )
        )
    );
    assert!(!env.exists(&intent_pda(&trader.key.pubkey(), 0)));
    assert_eq!(env.user(&trader.key.pubkey())?.nonce_bitmap, [0; 4]);
    Ok(())
}

#[test]
fn input_and_output_mint_must_differ() -> TestResult {
    let (mut env, mut market, mut trader) = setup()?;
    market.output_mint = market.input_mint;
    trader.receiver = trader.input;
    assert_eq!(
        env.create_intent(&trader, &market, &swap_spec(0, 10)?)
            .err(),
        Some(engine_error(EngineError::SameMint))
    );
    Ok(())
}

#[test]
fn token_2022_mints_must_pass_extension_policy() -> TestResult {
    let t22 = anchor_spl::token_2022::ID;
    let cases: [(&[MintExt], &[MintExt], bool); 7] = [
        (&[], &[], true),
        (
            &[MintExt::MetadataPointer],
            &[MintExt::MetadataPointer],
            true,
        ),
        (&[MintExt::PermanentDelegate], &[], false),
        (&[MintExt::TransferHook], &[], false),
        (&[], &[MintExt::TransferHook], false),
        (&[MintExt::MintCloseAuthority], &[], false),
        (&[], &[MintExt::MintCloseAuthority], false),
    ];
    for (input, output, allowed) in cases {
        let mut env = Env::new()?;
        env.init_config()?;
        let market = env.market(t22, input, t22, output)?;
        let trader = env.trader(&market, FUNDED)?;
        let got = env.create_intent(&trader, &market, &swap_spec(0, 10)?);
        if allowed {
            assert!(got.is_ok(), "{input:?} {output:?} {got:?}");
        } else {
            assert_eq!(
                got.err(),
                Some(engine_error(EngineError::MintNotAllowed)),
                "{input:?} {output:?}"
            );
        }
    }
    Ok(())
}

#[test]
fn mixed_token_programs_are_supported() -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(anchor_spl::token_2022::ID, &[], anchor_spl::token::ID, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    env.create_intent(&trader, &market, &swap_spec(0, 10)?)?;
    assert_eq!(env.balance(&trader.input)?, FUNDED - 10);
    Ok(())
}

#[test]
fn account_type_cosplay_is_rejected() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    let mut ix = env.create_intent_ix(&trader, &market, &swap_spec(0, 10)?);
    if let Some(meta) = ix.accounts.get_mut(1) {
        meta.pubkey = user_pda(&owner);
    }
    assert_eq!(
        env.send(&trader.key, &[ix], &[]).err(),
        Some(anchor_error(ErrorCode::AccountDiscriminatorMismatch))
    );
    Ok(())
}

#[test]
fn config_owned_by_another_program_is_rejected() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let mut forged = env.svm.get_account(&config_pda()).ok_or("config missing")?;
    forged.owner = Pubkey::new_unique();
    env.svm.set_account(config_pda(), forged)?;
    assert_eq!(
        env.create_intent(&trader, &market, &swap_spec(0, 10)?)
            .err(),
        Some(anchor_error(ErrorCode::AccountOwnedByWrongProgram))
    );
    Ok(())
}

#[test]
fn stranger_cannot_cancel_and_refund_must_reach_owner() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    let spec = swap_spec(0, 10)?;
    env.create_intent(&trader, &market, &spec)?;
    let stranger = env.funded()?;
    let loot =
        env.create_token_account(&market.input_mint, &stranger.pubkey(), market.input_program)?;
    let mut ix = env.cancel_ix(&owner, &market, 0, &loot);
    if let Some(meta) = ix.accounts.get_mut(0) {
        meta.pubkey = stranger.pubkey();
    }
    assert_eq!(
        env.send(&stranger, &[ix], &[]).err(),
        Some(engine_error(EngineError::Unauthorized))
    );
    env.set_now(spec.expires_at);
    let ix = env.expire_ix(&stranger.pubkey(), &owner, &market, 0, &loot);
    assert_eq!(
        env.send(&stranger, &[ix], &[]).err(),
        Some(engine_error(EngineError::RefundNotCanonical))
    );
    let ix = env.close_ix_by(&stranger.pubkey(), &owner, &market, 0, &trader.input);
    assert_eq!(
        env.send(&stranger, &[ix], &[]).err(),
        Some(engine_error(EngineError::InvalidTransition))
    );
    assert_eq!(env.balance(&loot)?, 0);
    assert_eq!(env.balance(&vault_pda(&intent_pda(&owner, 0)))?, 10);
    Ok(())
}

#[test]
fn cancel_requires_owner_signature() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    env.create_intent(&trader, &market, &swap_spec(0, 10)?)?;
    let payer = env.funded()?;
    let mut ix = env.cancel_ix(&owner, &market, 0, &trader.input);
    if let Some(meta) = ix.accounts.get_mut(0) {
        meta.is_signer = false;
    }
    assert_eq!(
        env.send(&payer, &[ix], &[]).err(),
        Some(anchor_error(ErrorCode::AccountNotSigner))
    );
    Ok(())
}

#[test]
fn vault_of_another_intent_is_rejected() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    env.create_intent(&trader, &market, &swap_spec(0, 10)?)?;
    env.create_intent(&trader, &market, &swap_spec(1, 20)?)?;
    let mut ix = env.cancel_ix(&owner, &market, 0, &trader.input);
    if let Some(meta) = ix.accounts.get_mut(2) {
        meta.pubkey = vault_pda(&intent_pda(&owner, 1));
    }
    assert_eq!(
        env.send(&trader.key, &[ix], &[]).err(),
        Some(anchor_error(ErrorCode::ConstraintSeeds))
    );
    Ok(())
}

#[test]
fn close_rent_cannot_be_redirected() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    env.create_intent(&trader, &market, &swap_spec(0, 10)?)?;
    let ix = env.cancel_ix(&owner, &market, 0, &trader.input);
    env.send(&trader.key, &[ix], &[])?;
    let thief = env.funded()?;
    let ix = env.close_ix_with(
        &thief.pubkey(),
        &owner,
        &thief.pubkey(),
        &market,
        0,
        &trader.input,
    );
    assert_eq!(
        env.send(&thief, &[ix], &[]).err(),
        Some(engine_error(EngineError::Unauthorized))
    );
    Ok(())
}

#[test]
fn permissionless_refunds_prefer_the_owners_canonical_account() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    let spec = swap_spec(0, 10)?;
    env.create_intent(&trader, &market, &spec)?;
    let cranker = env.funded()?;
    let side = env.create_token_account(&market.input_mint, &owner, market.input_program)?;
    env.set_now(spec.expires_at);
    let ix = env.expire_ix(&cranker.pubkey(), &owner, &market, 0, &side);
    assert_eq!(
        env.send(&cranker, &[ix], &[]).err(),
        Some(engine_error(EngineError::RefundNotCanonical))
    );
    let ix = env.expire_ix(&cranker.pubkey(), &owner, &market, 0, &trader.input);
    env.send(&cranker, &[ix], &[])?;
    assert_eq!(env.balance(&side)?, 0);
    assert_eq!(env.balance(&trader.input)?, FUNDED);
    let ix = env.close_ix_by(&cranker.pubkey(), &owner, &market, 0, &side);
    env.send(&cranker, &[ix], &[])?;
    assert!(!env.exists(&intent_pda(&owner, 0)));
    Ok(())
}

#[test]
fn reassigned_canonical_account_cannot_receive_refunds() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    let spec = swap_spec(0, 10)?;
    env.create_intent(&trader, &market, &spec)?;
    env.create_intent(&trader, &market, &swap_spec(1, 10)?)?;
    let ix = env.cancel_ix(&owner, &market, 1, &trader.input);
    env.send(&trader.key, &[ix], &[])?;
    let thief = env.funded()?;
    env.reassign_owner(
        &trader.key,
        &trader.input,
        &thief.pubkey(),
        market.input_program,
    )?;
    env.set_now(spec.expires_at);
    let ix = env.expire_ix(&thief.pubkey(), &owner, &market, 0, &trader.input);
    assert_eq!(
        env.send(&thief, &[ix], &[]).err(),
        Some(engine_error(EngineError::RefundCannotReceive))
    );
    let ix = env.close_ix_by(&thief.pubkey(), &owner, &market, 1, &trader.input);
    env.send(&thief, &[ix], &[])?;
    assert_eq!(env.balance(&trader.input)?, FUNDED - 10);
    Ok(())
}

#[test]
fn receiver_controlled_by_engine_is_rejected() -> TestResult {
    let (mut env, market, mut trader) = setup()?;
    let owner = trader.key.pubkey();
    let engine_owned = user_pda(&owner);
    trader.receiver =
        env.create_token_account(&market.output_mint, &engine_owned, market.output_program)?;
    trader.receiver_authority = engine_owned;
    assert_eq!(
        env.create_intent(&trader, &market, &swap_spec(0, 10)?)
            .err(),
        Some(engine_error(EngineError::ReceiverNotAllowed))
    );
    Ok(())
}

#[test]
fn receiver_authority_must_be_receiver_owner() -> TestResult {
    let (mut env, market, mut trader) = setup()?;
    trader.receiver_authority = Pubkey::new_unique();
    assert_eq!(
        env.create_intent(&trader, &market, &swap_spec(0, 10)?)
            .err(),
        Some(engine_error(EngineError::ReceiverNotAllowed))
    );
    let wallet = Pubkey::new_unique();
    trader.receiver =
        env.create_token_account(&market.output_mint, &wallet, market.output_program)?;
    trader.receiver_authority = wallet;
    env.create_intent(&trader, &market, &swap_spec(0, 10)?)?;
    Ok(())
}

#[test]
fn dutch_auction_must_end_by_expiry() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let start = env.now();
    let expires_at = start.saturating_add(100);
    let spec = |nonce: u64, end_ts: i64| -> TestResult<svm_tests::IntentSpec> {
        let params = intent_core::kinds::dutch_auction::Params {
            amount_in: 10,
            start_out: 20,
            end_out: 10,
            start_ts: start,
            end_ts,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?;
        Ok(svm_tests::IntentSpec {
            nonce,
            kind: intent_core::kinds::Kind::DutchAuction as u8,
            params,
            expires_at,
            flags: 0,
            ext: Vec::new(),
        })
    };
    assert_eq!(
        env.create_intent(&trader, &market, &spec(0, expires_at.saturating_add(1))?)
            .err(),
        Some(engine_error(EngineError::AuctionOutlivesExpiry))
    );
    env.create_intent(&trader, &market, &spec(0, expires_at)?)?;
    Ok(())
}

#[test]
fn a_frozen_receiver_is_refused_at_creation() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let mut account = env.svm.get_account(&trader.receiver).ok_or("missing")?;
    *account.data.get_mut(108).ok_or("short")? = 2;
    env.svm.set_account(trader.receiver, account)?;
    assert_eq!(
        env.create_intent(&trader, &market, &swap_spec(0, 10)?)
            .err(),
        Some(engine_error(EngineError::ReceiverCannotReceive))
    );
    Ok(())
}

#[test]
fn a_receiver_demanding_memos_is_refused_at_creation() -> TestResult {
    let program = anchor_spl::token_2022::ID;
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(program, &[], program, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let owner = trader.key.pubkey();
    let grow = anchor_spl::token_2022::spl_token_2022::instruction::reallocate(
        &program,
        &trader.receiver,
        &owner,
        &owner,
        &[],
        &[anchor_spl::token_2022::spl_token_2022::extension::ExtensionType::MemoTransfer],
    )?;
    let memo = anchor_spl::token_2022::spl_token_2022::extension::memo_transfer::instruction::enable_required_transfer_memos(
        &program,
        &trader.receiver,
        &owner,
        &[],
    )?;
    env.send(&trader.key, &[grow, memo], &[])?;
    assert_eq!(
        env.create_intent(&trader, &market, &swap_spec(0, 10)?)
            .err(),
        Some(engine_error(EngineError::ReceiverCannotReceive))
    );
    Ok(())
}

#[test]
fn an_owner_may_name_a_receiver_nobody_can_sign_for() -> TestResult {
    let (mut env, market, mut trader) = setup()?;
    let owner = trader.key.pubkey();
    let unsignable = svm_tests::delegate_pda(&owner);
    trader.receiver =
        env.create_token_account(&market.output_mint, &unsignable, market.output_program)?;
    trader.receiver_authority = unsignable;
    env.create_intent(&trader, &market, &swap_spec(0, 10)?)?;
    assert_eq!(env.intent(&owner, 0)?.receiver, trader.receiver);
    Ok(())
}
