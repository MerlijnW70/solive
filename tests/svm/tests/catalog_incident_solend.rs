use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use intent_engine::errors::EngineError;
use solana_instruction::Instruction;
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{config_pda, engine_error, set_announce_fee_ix, Env, TestResult};

const ADMIN_AT: usize = 8;

fn admin_calls(env: &Env, attacker: &Pubkey) -> Vec<Instruction> {
    let mut settings = env.settings();
    settings.fee_recipient = *attacker;
    settings.fee_bps = env.max_fee_bps;
    vec![
        env.update_config_ix(attacker, settings),
        env.economics_ix(
            attacker,
            intent_engine::Economics {
                kind_fee_mask: 0,
                kind_fee_bps: [0; 4],
                partner_cut_bps: 0,
                crank_bounty: 1,
                create_fee: 1,
            },
        ),
        env.propose_admin_ix(attacker, *attacker),
        env.lower_pause_ix(attacker, 1),
        set_announce_fee_ix(attacker, 1),
    ]
}

fn redirected(mut ix: Instruction, to: Pubkey) -> Instruction {
    for meta in &mut ix.accounts {
        if meta.pubkey == config_pda() {
            meta.pubkey = to;
        }
    }
    ix
}

#[test]
fn a_config_the_attacker_made_naming_itself_admin_passes_no_admin_check() -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let attacker = env.funded()?;
    let mut market = env.svm.get_account(&config_pda()).ok_or("config missing")?;
    market
        .data
        .get_mut(ADMIN_AT..ADMIN_AT + 32)
        .ok_or("config too short")?
        .copy_from_slice(attacker.pubkey().as_ref());
    let fake = Pubkey::new_unique();
    env.svm.set_account(fake, market)?;
    let before = env.svm.get_account(&config_pda()).ok_or("config missing")?;
    for (i, ix) in admin_calls(&env, &attacker.pubkey())
        .into_iter()
        .enumerate()
    {
        let err = env.send(&attacker, &[redirected(ix, fake)], &[]).err();
        assert_eq!(
            err,
            Some(TransactionError::InstructionError(
                0,
                InstructionError::Custom(u32::from(ErrorCode::ConstraintAddress))
            )),
            "case {i}"
        );
    }
    assert_eq!(env.svm.get_account(&config_pda()), Some(before));
    Ok(())
}

#[test]
fn the_real_config_refuses_every_admin_call_the_attacker_signs() -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let attacker: Keypair = env.funded()?;
    let before = env.svm.get_account(&config_pda()).ok_or("config missing")?;
    for (i, ix) in admin_calls(&env, &attacker.pubkey())
        .into_iter()
        .enumerate()
    {
        assert_eq!(
            env.send(&attacker, &[ix], &[]).err(),
            Some(engine_error(EngineError::Unauthorized)),
            "case {i}"
        );
    }
    assert_eq!(env.svm.get_account(&config_pda()), Some(before));
    Ok(())
}
