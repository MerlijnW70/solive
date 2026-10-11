use anchor_lang::prelude::Pubkey;
use anchor_spl::token_2022::spl_token_2022::extension::memo_transfer::instruction::enable_required_transfer_memos;
use anchor_spl::token_2022::spl_token_2022::extension::{ExtensionType, StateWithExtensions};
use anchor_spl::token_2022::spl_token_2022::instruction as token_ix;
use anchor_spl::token_2022::spl_token_2022::state::Mint as MintState;
use intent_engine::errors::EngineError;
use intent_engine::events::{IntentClosed, IntentExpired};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    delegate_pda, engine_error, events, intent_pda, swap_spec, vault_pda, Env, Market, TestResult,
    Trader,
};

const FUNDED: u64 = 1_000;
const ESCROW: u64 = 40;
const PROGRAMS: [Pubkey; 2] = [anchor_spl::token::ID, anchor_spl::token_2022::ID];
const ACCOUNT_STATE_OFFSET: usize = 108;
const FROZEN: u8 = 2;

fn opened(program: Pubkey) -> TestResult<(Env, Market, Trader)> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(program, &[], program, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    env.create_intent(&trader, &market, &swap_spec(0, ESCROW)?)?;
    Ok((env, market, trader))
}

fn cancelled(program: Pubkey) -> TestResult<(Env, Market, Trader)> {
    let (mut env, market, trader) = opened(program)?;
    let owner = trader.key.pubkey();
    let ix = env.cancel_ix(&owner, &market, 0, &trader.input);
    env.send(&trader.key, &[ix], &[])?;
    Ok((env, market, trader))
}

fn supply(env: &Env, mint: &Pubkey) -> TestResult<u64> {
    let account = env.svm.get_account(mint).ok_or("mint missing")?;
    Ok(StateWithExtensions::<MintState>::unpack(&account.data)?
        .base
        .supply)
}

fn donate(env: &mut Env, market: &Market, owner: &Pubkey, amount: u64) -> TestResult {
    env.mint_to(
        &market.input_mint,
        &vault_pda(&intent_pda(owner, 0)),
        market.input_program,
        amount,
    )
}

fn fresh(env: &mut Env, market: &Market, owner: &Pubkey) -> TestResult<Pubkey> {
    env.create_token_account(&market.input_mint, owner, market.input_program)
}

fn try_close(
    env: &mut Env,
    market: &Market,
    owner: &Pubkey,
    refund_to: &Pubkey,
) -> Result<IntentClosed, TransactionError> {
    let closer = Keypair::new();
    env.svm
        .airdrop(&closer.pubkey(), 1_000_000_000)
        .map_err(|f| f.err)?;
    let ix = env.close_ix_by(&closer.pubkey(), owner, market, 0, refund_to);
    let meta = env.send(&closer, &[ix], &[])?;
    events::<IntentClosed>(&meta)
        .pop()
        .ok_or(TransactionError::AccountNotFound)
}

fn refused_then_rescued(
    env: &mut Env,
    market: &Market,
    trader: &Trader,
    donated: u64,
) -> TestResult {
    let owner = trader.key.pubkey();
    assert_eq!(
        try_close(env, market, &owner, &trader.input).err(),
        Some(engine_error(EngineError::RefundCannotReceive))
    );
    let rescue = fresh(env, market, &owner)?;
    let before = supply(env, &market.input_mint)?;
    let closed = try_close(env, market, &owner, &rescue)?;
    assert_eq!((closed.swept, closed.refund_to), (donated, rescue));
    assert_eq!(env.balance(&rescue)?, donated);
    assert_eq!(supply(env, &market.input_mint)?, before);
    assert!(!env.exists(&intent_pda(&owner, 0)));
    assert!(!env.exists(&vault_pda(&intent_pda(&owner, 0))));
    Ok(())
}

#[test]
fn an_empty_vault_closes_whatever_refund_account_is_named() -> TestResult {
    let (mut env, market, trader) = cancelled(anchor_spl::token::ID)?;
    let owner = trader.key.pubkey();
    let thief = env.funded()?;
    env.reassign_owner(
        &trader.key,
        &trader.input,
        &thief.pubkey(),
        market.input_program,
    )?;
    let closed = try_close(&mut env, &market, &owner, &trader.input)?;
    assert_eq!(closed.swept, 0);
    assert_eq!(env.balance(&trader.input)?, FUNDED);
    Ok(())
}

#[test]
fn donations_reach_a_healthy_canonical_account_on_both_token_programs() -> TestResult {
    for program in PROGRAMS {
        let (mut env, market, trader) = cancelled(program)?;
        let owner = trader.key.pubkey();
        donate(&mut env, &market, &owner, 6)?;
        let closed = try_close(&mut env, &market, &owner, &trader.input)?;
        assert_eq!((closed.swept, closed.refund_to), (6, trader.input));
        assert_eq!(env.balance(&trader.input)?, FUNDED + 6);
    }
    Ok(())
}

#[test]
fn a_reassigned_refund_account_is_refused_and_a_fresh_one_rescues_close() -> TestResult {
    let (mut env, market, trader) = cancelled(anchor_spl::token::ID)?;
    let owner = trader.key.pubkey();
    let thief = env.funded()?;
    env.reassign_owner(
        &trader.key,
        &trader.input,
        &thief.pubkey(),
        market.input_program,
    )?;
    donate(&mut env, &market, &owner, 5)?;
    refused_then_rescued(&mut env, &market, &trader, 5)?;
    assert_eq!(env.balance(&trader.input)?, FUNDED);
    Ok(())
}

#[test]
fn a_closed_refund_account_must_be_recreated_rather_than_bypassed() -> TestResult {
    for program in PROGRAMS {
        let (mut env, market, trader) = cancelled(program)?;
        let owner = trader.key.pubkey();
        let elsewhere = fresh(&mut env, &market, &owner)?;
        env.transfer(
            &trader.key,
            &trader.input,
            &market.input_mint,
            &elsewhere,
            program,
            FUNDED,
        )?;
        let shut = token_ix::close_account(&program, &trader.input, &owner, &owner, &[])?;
        env.send(&trader.key, &[shut], &[])?;
        donate(&mut env, &market, &owner, 3)?;
        assert_eq!(
            try_close(&mut env, &market, &owner, &elsewhere).err(),
            Some(engine_error(EngineError::RefundNotCanonical))
        );
        assert_eq!(
            try_close(&mut env, &market, &owner, &trader.input).err(),
            Some(engine_error(EngineError::RefundCannotReceive))
        );
        env.create_ata(&owner, &market.input_mint, program)?;
        let closed = try_close(&mut env, &market, &owner, &trader.input)?;
        assert_eq!((closed.swept, closed.refund_to), (3, trader.input));
        assert_eq!(env.balance(&trader.input)?, 3);
    }
    Ok(())
}

#[test]
fn a_frozen_refund_account_is_refused_and_a_fresh_one_rescues_close() -> TestResult {
    for program in PROGRAMS {
        let (mut env, market, trader) = cancelled(program)?;
        let owner = trader.key.pubkey();
        let mut account = env.svm.get_account(&trader.input).ok_or("missing")?;
        *account.data.get_mut(ACCOUNT_STATE_OFFSET).ok_or("short")? = FROZEN;
        env.svm.set_account(trader.input, account)?;
        donate(&mut env, &market, &owner, 4)?;
        refused_then_rescued(&mut env, &market, &trader, 4)?;
    }
    Ok(())
}

#[test]
fn a_memo_demanding_refund_account_is_refused_and_a_fresh_one_rescues_close() -> TestResult {
    let program = anchor_spl::token_2022::ID;
    let (mut env, market, trader) = cancelled(program)?;
    let owner = trader.key.pubkey();
    let grow = token_ix::reallocate(
        &program,
        &trader.input,
        &owner,
        &owner,
        &[],
        &[ExtensionType::MemoTransfer],
    )?;
    let memo = enable_required_transfer_memos(&program, &trader.input, &owner, &[])?;
    env.send(&trader.key, &[grow, memo], &[])?;
    donate(&mut env, &market, &owner, 2)?;
    refused_then_rescued(&mut env, &market, &trader, 2)
}

#[test]
fn while_the_canonical_account_can_receive_no_other_account_may_be_named() -> TestResult {
    for program in PROGRAMS {
        let (mut env, market, trader) = cancelled(program)?;
        let owner = trader.key.pubkey();
        donate(&mut env, &market, &owner, 1)?;
        let side = fresh(&mut env, &market, &owner)?;
        assert_eq!(
            try_close(&mut env, &market, &owner, &side).err(),
            Some(engine_error(EngineError::RefundNotCanonical))
        );
        let closed = try_close(&mut env, &market, &owner, &trader.input)?;
        assert_eq!((closed.swept, closed.refund_to), (1, trader.input));
    }
    Ok(())
}

#[test]
fn accounts_that_are_not_the_owners_token_accounts_are_refused() -> TestResult {
    let (mut env, market, trader) = cancelled(anchor_spl::token::ID)?;
    let owner = trader.key.pubkey();
    let thief = env.funded()?;
    env.reassign_owner(
        &trader.key,
        &trader.input,
        &thief.pubkey(),
        market.input_program,
    )?;
    donate(&mut env, &market, &owner, 1)?;
    let stranger = env.funded()?;
    let theirs =
        env.create_token_account(&market.input_mint, &stranger.pubkey(), market.input_program)?;
    let wrong_mint =
        env.create_token_account(&market.output_mint, &owner, market.output_program)?;
    let mint_shaped = Pubkey::new_unique();
    let mint = env.svm.get_account(&market.input_mint).ok_or("missing")?;
    env.svm.set_account(mint_shaped, mint)?;
    let foreign_program = Pubkey::new_unique();
    let mut lookalike = env.svm.get_account(&trader.input).ok_or("missing")?;
    lookalike.owner = anchor_spl::token_2022::ID;
    env.svm.set_account(foreign_program, lookalike)?;
    for refund_to in [
        theirs,
        wrong_mint,
        mint_shaped,
        foreign_program,
        Pubkey::new_unique(),
    ] {
        assert_eq!(
            try_close(&mut env, &market, &owner, &refund_to).err(),
            Some(engine_error(EngineError::RefundCannotReceive)),
            "{refund_to}"
        );
    }
    Ok(())
}

#[test]
fn an_owner_account_with_a_foreign_delegate_is_refused_but_the_engine_delegate_is_fine(
) -> TestResult {
    let (mut env, market, trader) = cancelled(anchor_spl::token::ID)?;
    let owner = trader.key.pubkey();
    donate(&mut env, &market, &owner, 7)?;
    let drainer = env.funded()?;
    let approve = token_ix::approve(
        &market.input_program,
        &trader.input,
        &drainer.pubkey(),
        &owner,
        &[],
        u64::MAX,
    )?;
    env.send(&trader.key, &[approve], &[])?;
    assert_eq!(
        try_close(&mut env, &market, &owner, &trader.input).err(),
        Some(engine_error(EngineError::RefundCannotReceive))
    );
    let engine = token_ix::approve(
        &market.input_program,
        &trader.input,
        &delegate_pda(&owner),
        &owner,
        &[],
        10,
    )?;
    env.send(&trader.key, &[engine], &[])?;
    let closed = try_close(&mut env, &market, &owner, &trader.input)?;
    assert_eq!(closed.swept, 7);
    Ok(())
}

#[test]
fn an_owner_account_with_a_foreign_close_authority_is_refused() -> TestResult {
    let (mut env, market, trader) = cancelled(anchor_spl::token::ID)?;
    let owner = trader.key.pubkey();
    donate(&mut env, &market, &owner, 2)?;
    let other = env.funded()?;
    let hand_over = token_ix::set_authority(
        &market.input_program,
        &trader.input,
        Some(&other.pubkey()),
        token_ix::AuthorityType::CloseAccount,
        &owner,
        &[],
    )?;
    env.send(&trader.key, &[hand_over], &[])?;
    assert_eq!(
        try_close(&mut env, &market, &owner, &trader.input).err(),
        Some(engine_error(EngineError::RefundCannotReceive))
    );
    let back = token_ix::set_authority(
        &market.input_program,
        &trader.input,
        Some(&owner),
        token_ix::AuthorityType::CloseAccount,
        &other.pubkey(),
        &[],
    )?;
    env.send(&other, &[back], &[])?;
    let closed = try_close(&mut env, &market, &owner, &trader.input)?;
    assert_eq!(closed.swept, 2);
    Ok(())
}

#[test]
fn the_owner_cannot_block_expiry_and_the_refund_lands_where_the_event_says() -> TestResult {
    let (mut env, market, trader) = opened(anchor_spl::token::ID)?;
    let owner = trader.key.pubkey();
    let thief = env.funded()?;
    env.reassign_owner(
        &trader.key,
        &trader.input,
        &thief.pubkey(),
        market.input_program,
    )?;
    env.set_now(swap_spec(0, ESCROW)?.expires_at);
    let cranker = env.funded()?;
    let ix = env.expire_ix(&cranker.pubkey(), &owner, &market, 0, &trader.input);
    assert_eq!(
        env.send(&cranker, &[ix], &[]).err(),
        Some(engine_error(EngineError::RefundCannotReceive))
    );
    let rescue = fresh(&mut env, &market, &owner)?;
    let ix = env.expire_ix(&cranker.pubkey(), &owner, &market, 0, &rescue);
    let meta = env.send(&cranker, &[ix], &[])?;
    let expired = events::<IntentExpired>(&meta)
        .pop()
        .ok_or("no expire event")?;
    assert_eq!((expired.refunded, expired.refund_to), (ESCROW, rescue));
    assert_eq!(env.balance(&rescue)?, ESCROW);
    assert_eq!(env.balance(&trader.input)?, FUNDED - ESCROW);
    let closed = try_close(&mut env, &market, &owner, &rescue)?;
    assert_eq!(closed.swept, 0);
    Ok(())
}

fn native_mint(env: &mut Env) -> TestResult<Pubkey> {
    let mint = anchor_spl::token::spl_token::native_mint::ID;
    if !env.exists(&mint) {
        let template = env.create_mint_with_decimals(anchor_spl::token::ID, &[], 9)?;
        let mut account = env.svm.get_account(&template).ok_or("missing")?;
        account.data.get_mut(..36).ok_or("short")?.fill(0);
        env.svm.set_account(mint, account)?;
    }
    Ok(mint)
}

fn wrap(env: &mut Env, payer: &Keypair, account: &Pubkey, lamports: u64) -> TestResult {
    let fund = solana_system_interface::instruction::transfer(&payer.pubkey(), account, lamports);
    let sync = token_ix::sync_native(&anchor_spl::token::ID, account)?;
    env.send(payer, &[fund, sync], &[])?;
    Ok(())
}

#[test]
fn wrapped_sol_donations_reach_a_recreated_canonical_account() -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let program = anchor_spl::token::ID;
    let input_mint = native_mint(&mut env)?;
    let market = Market {
        input_mint,
        output_mint: env.create_mint(program, &[])?,
        input_program: program,
        output_program: program,
    };
    let key = env.funded()?;
    let owner = key.pubkey();
    env.init_user(&key)?;
    let input = env.create_ata(&owner, &input_mint, program)?;
    wrap(&mut env, &key, &input, 5_000)?;
    let receiver = env.create_token_account(&market.output_mint, &owner, program)?;
    let trader = Trader {
        key,
        input,
        receiver,
        receiver_authority: owner,
    };
    env.create_intent(&trader, &market, &swap_spec(0, ESCROW)?)?;
    let ix = env.cancel_ix(&owner, &market, 0, &trader.input);
    env.send(&trader.key, &[ix], &[])?;
    assert_eq!(env.balance(&trader.input)?, 5_000);
    let shut = token_ix::close_account(&program, &trader.input, &owner, &owner, &[])?;
    env.send(&trader.key, &[shut], &[])?;
    let donor = env.funded()?;
    wrap(&mut env, &donor, &vault_pda(&intent_pda(&owner, 0)), 9)?;
    assert_eq!(env.balance(&vault_pda(&intent_pda(&owner, 0)))?, 9);
    let side = env.create_token_account(&input_mint, &owner, program)?;
    assert_eq!(
        try_close(&mut env, &market, &owner, &side).err(),
        Some(engine_error(EngineError::RefundNotCanonical))
    );
    assert_eq!(
        try_close(&mut env, &market, &owner, &trader.input).err(),
        Some(engine_error(EngineError::RefundCannotReceive))
    );
    env.create_ata(&owner, &input_mint, program)?;
    let closed = try_close(&mut env, &market, &owner, &trader.input)?;
    assert_eq!((closed.swept, closed.refund_to), (9, trader.input));
    assert_eq!(env.balance(&trader.input)?, 9);
    assert!(!env.exists(&vault_pda(&intent_pda(&owner, 0))));
    Ok(())
}
