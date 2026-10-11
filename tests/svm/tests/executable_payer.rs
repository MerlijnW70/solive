use anchor_lang::prelude::Pubkey;
use intent_engine::events::IntentClosed;
use solana_keypair::Keypair;
use solana_signer::Signer;
use svm_tests::{
    events, intent_pda, relay_program_path, swap_spec, vault_pda, Env, Market, TestResult, Trader,
};

const FUNDED: u64 = 1_000;
const ESCROW: u64 = 40;
const DONATED: u64 = 7;
const PROGRAMS: [Pubkey; 2] = [anchor_spl::token::ID, anchor_spl::token_2022::ID];

fn opened(program: Pubkey) -> TestResult<(Env, Market, Trader)> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(program, &[], program, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    env.create_intent(&trader, &market, &swap_spec(0, ESCROW)?)?;
    Ok((env, market, trader))
}

fn deploy_over(env: &mut Env, key: &Pubkey) -> TestResult {
    env.svm.add_program_from_file(*key, relay_program_path())?;
    let account = env.svm.get_account(key).ok_or("payer missing")?;
    assert!(account.executable);
    Ok(())
}

fn close(
    env: &mut Env,
    market: &Market,
    trader: &Trader,
) -> TestResult<(IntentClosed, Pubkey, u64, u64)> {
    let owner = trader.key.pubkey();
    let intent = intent_pda(&owner, 0);
    let held = env
        .lamports(&intent)
        .checked_add(env.lamports(&vault_pda(&intent)))
        .ok_or("overflow")?;
    let payer = env.funded()?;
    let cranker = Keypair::new();
    env.svm
        .airdrop(&cranker.pubkey(), 1_000_000_000)
        .map_err(|f| format!("airdrop: {:?}", f.err))?;
    let before = env.lamports(&cranker.pubkey());
    let ix = env.close_ix_by(&cranker.pubkey(), &owner, market, 0, &trader.input);
    let meta = env.send(&payer, &[ix], &[&cranker])?;
    assert!(!env.exists(&intent));
    assert!(!env.exists(&vault_pda(&intent)));
    let closed = events::<IntentClosed>(&meta).pop().ok_or("missing event")?;
    let gained = env
        .lamports(&cranker.pubkey())
        .checked_sub(before)
        .ok_or("cranker lost lamports")?;
    Ok((closed, cranker.pubkey(), gained, held))
}

#[test]
fn a_cancelled_intent_closes_after_its_rent_payer_became_a_program() -> TestResult {
    for program in PROGRAMS {
        let (mut env, market, trader) = opened(program)?;
        let owner = trader.key.pubkey();
        let ix = env.cancel_ix(&owner, &market, 0, &trader.input);
        env.send(&trader.key, &[ix], &[])?;
        env.mint_to(
            &market.input_mint,
            &vault_pda(&intent_pda(&owner, 0)),
            market.input_program,
            DONATED,
        )?;
        deploy_over(&mut env, &owner)?;
        let payer_lamports = env.lamports(&owner);
        let (closed, cranker, gained, held) = close(&mut env, &market, &trader)?;
        assert_eq!((closed.rent_to, closed.bounty_to), (cranker, cranker));
        assert_eq!((closed.swept, closed.refund_to), (DONATED, trader.input));
        assert_eq!(gained, held);
        assert_eq!(env.lamports(&owner), payer_lamports);
        assert_eq!(
            env.balance(&trader.input)?,
            FUNDED.checked_add(DONATED).ok_or("overflow")?
        );
    }
    Ok(())
}

#[test]
fn an_expired_intent_closes_after_its_rent_payer_became_a_program() -> TestResult {
    let (mut env, market, trader) = opened(anchor_spl::token::ID)?;
    let owner = trader.key.pubkey();
    let expires_at = swap_spec(0, ESCROW)?.expires_at;
    env.set_now(expires_at);
    let cranker = env.funded()?;
    let ix = env.expire_ix(&cranker.pubkey(), &owner, &market, 0, &trader.input);
    env.send(&cranker, &[ix], &[])?;
    deploy_over(&mut env, &owner)?;
    let (closed, cranker, gained, held) = close(&mut env, &market, &trader)?;
    assert_eq!((closed.rent_to, closed.bounty_to), (cranker, cranker));
    assert_eq!(gained, held);
    assert_eq!(env.balance(&trader.input)?, FUNDED);
    Ok(())
}

#[test]
fn a_rent_payer_that_is_not_a_program_keeps_its_rent() -> TestResult {
    let (mut env, market, trader) = opened(anchor_spl::token::ID)?;
    let owner = trader.key.pubkey();
    let ix = env.cancel_ix(&owner, &market, 0, &trader.input);
    env.send(&trader.key, &[ix], &[])?;
    let intent = intent_pda(&owner, 0);
    let held = env
        .lamports(&intent)
        .checked_add(env.lamports(&vault_pda(&intent)))
        .ok_or("overflow")?;
    let before = env.lamports(&owner);
    let (closed, cranker, gained, _) = close(&mut env, &market, &trader)?;
    assert_eq!((closed.rent_to, closed.bounty_to), (owner, owner));
    assert_ne!(cranker, owner);
    assert_eq!(gained, 0);
    assert_eq!(env.lamports(&owner).checked_sub(before), Some(held));
    Ok(())
}
