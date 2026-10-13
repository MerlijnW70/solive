use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use solana_instruction::Instruction;
use solana_signer::Signer;
use svm_tests::{
    anchor_error, config_pda, event_authority, intent_pda, swap_spec, vault_pda, Env, Market,
    TestResult, Trader,
};

const FUNDED: u64 = 1_000;
const ESCROW: u64 = 400;

fn setup() -> TestResult<(Env, Market, Trader)> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(anchor_spl::token::ID, &[], anchor_spl::token::ID, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    Ok((env, market, trader))
}

fn forge(ix: &mut Instruction, real: &Pubkey, fake: Pubkey) -> TestResult {
    let meta = ix
        .accounts
        .iter_mut()
        .find(|m| m.pubkey == *real && !m.is_signer)
        .ok_or("account not in instruction")?;
    meta.pubkey = fake;
    Ok(())
}

#[test]
fn a_fill_cannot_misroute_its_event_cpi_through_a_forged_event_authority() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    env.create_intent(&trader, &market, &swap_spec(0, ESCROW)?)?;
    let vault = vault_pda(&intent_pda(&owner, 0));
    let real = event_authority();
    for fake in [Pubkey::new_unique(), config_pda(), vault] {
        let solver = env.solver(&market, 1_000)?;
        let fee_to = env.fee_account(&market)?;
        let mut fill = env.fill_ix(
            &solver,
            &owner,
            &market,
            0,
            &trader.receiver,
            Some(&fee_to),
            1_000,
        );
        forge(&mut fill, &real, fake)?;
        assert_eq!(
            env.send(&solver.key, &[fill], &[]),
            Err(anchor_error(ErrorCode::ConstraintAddress))
        );
    }
    assert_eq!(env.balance(&trader.receiver)?, 0);
    assert_eq!(env.balance(&vault)?, ESCROW);
    Ok(())
}
