use intent_core::fee::split_fees;
use intent_core::kinds::{attested_result, Kind};
use solana_keypair::Keypair;
use solana_signer::Signer;
use svm_tests::{
    attestation_proof_message, ed25519_ix, intent_pda, partner_ext, swap_spec, vault_pda, Env,
    IntentSpec, TestResult, DOMAIN,
};

const FUNDED: u64 = 1_000;
const ESCROW: u64 = 400;
const JUDGE_FEE: u64 = 40;
const PARTNER_BPS: u16 = 30;
const SPEC: [u8; 32] = [0x5d; 32];

#[test]
fn a_proof_escrow_whose_partner_is_its_judge_pays_both_fees_into_the_one_account() -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(anchor_spl::token::ID, &[], anchor_spl::token::ID, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let owner = trader.key.pubkey();
    let judge = Keypair::new();
    let spec = IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: ESCROW,
            min_result: 1,
            max_result: 1,
            attestor: judge.pubkey().to_bytes(),
            spec_hash: SPEC,
            judge_fee: JUDGE_FEE,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ext: partner_ext(&judge.pubkey(), PARTNER_BPS),
        ..swap_spec(0, ESCROW)?
    };
    env.create_intent(&trader, &market, &spec)?;
    let intent = intent_pda(&owner, 0);
    let recorded = env.intent(&owner, 0)?;
    let worker = env.solver(&market, 0)?;
    let payee = worker.input;
    let fee_to = env.fee_account(&market)?;
    let judge_ata = env.create_ata(&judge.pubkey(), &market.input_mint, market.input_program)?;
    env.judge_to = Some(judge_ata);
    env.partner_to = Some(judge_ata);
    let delivery = env.announce_for(&worker.key, &intent)?;
    let message = attestation_proof_message(
        DOMAIN,
        &judge.pubkey(),
        &intent,
        &payee,
        ESCROW,
        1,
        SPEC,
        &delivery,
    );
    let release = env.fill_attested_ix(
        &worker.key.pubkey(),
        &owner,
        &market,
        0,
        &payee,
        Some(&fee_to),
        1,
    );
    let before = (
        env.balance(&payee)?,
        env.balance(&fee_to)?,
        env.balance(&judge_ata)?,
    );
    env.send(&worker.key, &[ed25519_ix(&judge, &message), release], &[])?;
    let after = (
        env.balance(&payee)?,
        env.balance(&fee_to)?,
        env.balance(&judge_ata)?,
    );
    let fees = split_fees(
        ESCROW.saturating_sub(JUDGE_FEE),
        recorded.fee_bps,
        recorded.partner_bps,
        recorded.partner_cut_bps,
    )
    .map_err(|e| format!("{e:?}"))?;
    let gained = (
        after.0.saturating_sub(before.0),
        after.1.saturating_sub(before.1),
        after.2.saturating_sub(before.2),
    );
    assert_eq!(env.balance(&vault_pda(&intent))?, 0);
    assert_eq!(gained.0, fees.net);
    assert_eq!(gained.1, fees.protocol);
    assert_eq!(Some(gained.2), JUDGE_FEE.checked_add(fees.partner));
    assert_eq!(
        gained
            .0
            .checked_add(gained.1)
            .and_then(|s| s.checked_add(gained.2)),
        Some(ESCROW)
    );
    Ok(())
}
