use anchor_lang::prelude::Pubkey;
use intent_core::bounty::split_n;
use intent_core::kinds::{attested_result, Kind};
use intent_engine::errors::EngineError;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;
use svm_tests::{
    cosign_batch_ix, engine_error_at, intent_pda, split_commit, split_digest, swap_spec, vault_pda,
    Env, IntentSpec, Market, TestResult, Trader, DOMAIN,
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

fn proof_spec(attestor: &Keypair, spec_hash: [u8; 32]) -> TestResult<IntentSpec> {
    Ok(IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: ESCROW,
            min_result: 1,
            max_result: 1,
            attestor: attestor.pubkey().to_bytes(),
            spec_hash,
            judge_fee: 0,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ..swap_spec(0, ESCROW)?
    })
}

#[test]
fn a_settled_collaborative_split_cannot_be_settled_a_second_time() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    let attestor = Keypair::new();
    const SPEC: [u8; 32] = [0x5e; 32];
    let coauthors = [Keypair::new(), Keypair::new(), Keypair::new()];
    let recipients: Vec<Pubkey> = coauthors.iter().map(Signer::pubkey).collect();
    let weights = [4000u16, 3500, 2500];
    env.create_intent(&trader, &market, &proof_spec(&attestor, SPEC)?)?;
    let intent = intent_pda(&owner, 0);
    let solver = env.solver(&market, 0)?;
    let fee_to = env.fee_account(&market)?;
    let mut atas = Vec::new();
    for r in &recipients {
        atas.push(env.create_ata(r, &market.input_mint, market.input_program)?);
    }
    let split_hash = split_commit(&recipients, &weights);
    let digest = split_digest(DOMAIN, &intent, ESCROW, 1, SPEC, split_hash);
    let claim = |env: &Env| {
        env.fill_attested_split_ix(
            &solver.key.pubkey(),
            &owner,
            &market,
            0,
            &recipients,
            &weights,
            Some(&fee_to),
            1,
        )
    };
    let signers: Vec<&Keypair> = coauthors.iter().chain(std::iter::once(&attestor)).collect();
    let first: Vec<Instruction> = vec![cosign_batch_ix(&signers, &digest)?, claim(&env)];
    env.send(&solver.key, &first, &[])?;
    assert_eq!(
        env.balance(&vault_pda(&intent))?,
        0,
        "the first settle drains the escrow"
    );
    let mut settled = Vec::new();
    for a in &atas {
        settled.push(env.balance(a)?);
    }
    let net: u64 = settled.iter().sum();
    let plan = split_n(net, &weights).map_err(|e| format!("{e:?}"))?;
    assert_eq!(
        settled.as_slice(),
        plan.as_slice(),
        "each co-author receives its weighted share from the only settle"
    );
    let again: Vec<Instruction> = vec![cosign_batch_ix(&signers, &digest)?, claim(&env)];
    let fill_index = u8::try_from(again.len().saturating_sub(1))?;
    assert_eq!(
        env.send(&solver.key, &again, &[]).err(),
        Some(engine_error_at(fill_index, EngineError::InvalidTransition)),
        "a second settle of the same intent is rejected once it is no longer open"
    );
    let mut after = Vec::new();
    for a in &atas {
        after.push(env.balance(a)?);
    }
    assert_eq!(
        after.as_slice(),
        settled.as_slice(),
        "the rejected second settle pays no co-author twice"
    );
    assert_eq!(
        env.balance(&vault_pda(&intent))?,
        0,
        "the drained vault stays empty after the rejected second settle"
    );
    Ok(())
}
