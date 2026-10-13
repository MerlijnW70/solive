use anchor_lang::prelude::Pubkey;
use intent_core::bounty::split_n;
use intent_core::kinds::{attested_result, Kind};
use intent_engine::errors::EngineError;
use solana_keypair::Keypair;
use solana_signer::Signer;
use svm_tests::{
    attestation_split_message, ed25519_ix, engine_error_at, intent_pda, split_commit, swap_spec,
    vault_pda, Env, IntentSpec, Market, TestResult, Trader, DOMAIN,
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

#[test]
fn a_collaborative_claim_splits_the_net_across_co_authors_and_conserves() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    let attestor = Keypair::new();
    const SPEC: [u8; 32] = [0x5e; 32];
    let recipients = [
        Pubkey::new_unique(),
        Pubkey::new_unique(),
        Pubkey::new_unique(),
    ];
    let weights = [4000u16, 3500, 2500];
    let spec = IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: ESCROW,
            min_result: 1,
            max_result: 1,
            attestor: attestor.pubkey().to_bytes(),
            spec_hash: SPEC,
            judge_fee: 0,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ..swap_spec(0, ESCROW)?
    };
    env.create_intent(&trader, &market, &spec)?;
    let intent = intent_pda(&owner, 0);
    let solver = env.solver(&market, 0)?;
    let fee_to = env.fee_account(&market)?;
    let mut atas = Vec::new();
    for r in &recipients {
        atas.push(env.create_ata(r, &market.input_mint, market.input_program)?);
    }
    let fee_before = env.balance(&fee_to)?;
    let split_hash = split_commit(&recipients, &weights);
    let msg = attestation_split_message(
        DOMAIN,
        &attestor.pubkey(),
        &intent,
        ESCROW,
        1,
        SPEC,
        split_hash,
    );
    let fill = env.fill_attested_split_ix(
        &solver.key.pubkey(),
        &owner,
        &market,
        0,
        &recipients,
        &weights,
        Some(&fee_to),
        1,
    );
    env.send(&solver.key, &[ed25519_ix(&attestor, &msg), fill], &[])?;
    let protocol = env.balance(&fee_to)? - fee_before;
    let mut paid = Vec::new();
    for a in &atas {
        paid.push(env.balance(a)?);
    }
    let net: u64 = paid.iter().sum();
    let plan = split_n(net, &weights).map_err(|e| format!("{e:?}"))?;
    assert_eq!(
        paid.as_slice(),
        plan.as_slice(),
        "each co-author receives its weighted share of the net"
    );
    assert_eq!(env.balance(&vault_pda(&intent))?, 0, "the vault is drained");
    assert_eq!(net + protocol, ESCROW, "nothing is minted or lost");
    Ok(())
}

#[test]
fn a_collaborative_claim_rejects_a_split_the_attestor_did_not_sign() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    let attestor = Keypair::new();
    const SPEC: [u8; 32] = [0x5e; 32];
    let recipients = [
        Pubkey::new_unique(),
        Pubkey::new_unique(),
        Pubkey::new_unique(),
    ];
    let signed = [4000u16, 3500, 2500];
    let tampered = [8000u16, 1000, 1000];
    let spec = IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: ESCROW,
            min_result: 1,
            max_result: 1,
            attestor: attestor.pubkey().to_bytes(),
            spec_hash: SPEC,
            judge_fee: 0,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ..swap_spec(0, ESCROW)?
    };
    env.create_intent(&trader, &market, &spec)?;
    let intent = intent_pda(&owner, 0);
    let solver = env.solver(&market, 0)?;
    let fee_to = env.fee_account(&market)?;
    for r in &recipients {
        env.create_ata(r, &market.input_mint, market.input_program)?;
    }
    let split_hash = split_commit(&recipients, &signed);
    let msg = attestation_split_message(
        DOMAIN,
        &attestor.pubkey(),
        &intent,
        ESCROW,
        1,
        SPEC,
        split_hash,
    );
    let fill = env.fill_attested_split_ix(
        &solver.key.pubkey(),
        &owner,
        &market,
        0,
        &recipients,
        &tampered,
        Some(&fee_to),
        1,
    );
    assert_eq!(
        env.send(&solver.key, &[ed25519_ix(&attestor, &msg), fill], &[])
            .err(),
        Some(engine_error_at(1, EngineError::SigMessage)),
        "a split the attestor never signed over is rejected"
    );
    assert_eq!(
        env.balance(&vault_pda(&intent))?,
        ESCROW,
        "the escrow is untouched after the rejected claim"
    );
    Ok(())
}
