use anchor_lang::prelude::Pubkey;
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

fn proof_spec(attestor: &Keypair, spec_hash: [u8; 32], nonce: u64) -> TestResult<IntentSpec> {
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
        ..swap_spec(nonce, ESCROW)?
    })
}

#[test]
fn a_cosign_batch_for_one_intent_cannot_settle_a_different_intent() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    let attestor = Keypair::new();
    const SPEC: [u8; 32] = [0x5e; 32];
    let coauthors = [Keypair::new(), Keypair::new(), Keypair::new()];
    let recipients: Vec<Pubkey> = coauthors.iter().map(Signer::pubkey).collect();
    let weights = [4000u16, 3500, 2500];
    env.create_intent(&trader, &market, &proof_spec(&attestor, SPEC, 0)?)?;
    env.create_intent(&trader, &market, &proof_spec(&attestor, SPEC, 1)?)?;
    let intent_a = intent_pda(&owner, 0);
    let intent_b = intent_pda(&owner, 1);
    let solver = env.solver(&market, 0)?;
    let fee_to = env.fee_account(&market)?;
    for r in &recipients {
        env.create_ata(r, &market.input_mint, market.input_program)?;
    }
    let split_hash = split_commit(&recipients, &weights);
    let digest_a = split_digest(DOMAIN, &intent_a, ESCROW, 1, SPEC, split_hash);
    let fill_b = env.fill_attested_split_ix(
        &solver.key.pubkey(),
        &owner,
        &market,
        1,
        &recipients,
        &weights,
        Some(&fee_to),
        1,
    );
    let signers: Vec<&Keypair> = coauthors.iter().chain(std::iter::once(&attestor)).collect();
    let ixs: Vec<Instruction> = vec![cosign_batch_ix(&signers, &digest_a)?, fill_b];
    let fill_index = u8::try_from(ixs.len().saturating_sub(1))?;
    assert_eq!(
        env.send(&solver.key, &ixs, &[]).err(),
        Some(engine_error_at(fill_index, EngineError::SigMessage)),
        "signatures gathered for one intent cannot settle a different intent"
    );
    assert_eq!(
        env.balance(&vault_pda(&intent_b))?,
        ESCROW,
        "the replayed-against intent's escrow is untouched"
    );
    Ok(())
}
