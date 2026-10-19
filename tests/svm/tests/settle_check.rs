use anchor_lang::prelude::Pubkey;
use intent_core::fee::release_settles;
use intent_core::kinds::{attested_result, Kind};
use intent_engine::errors::EngineError;
use solana_keypair::Keypair;
use solana_signer::Signer;
use svm_tests::{
    agent_lane, attestation_proof_message, create_committee_ix, ed25519_ix, engine_error,
    engine_error_at, intent_pda, mandate_pda, mandate_terms, partner_ext, sorted_members,
    swap_spec, vault_pda, Env, IntentSpec, Market, TestResult, Trader, DOMAIN, START_TS,
};

const FUNDED: u64 = 1_000;
const ESCROW: u64 = 400;
const PARTNER_BPS: u16 = 50;
const SPEC: [u8; 32] = [0x5e; 32];
const SUBMIT_BY: i64 = START_TS + 600;
const STUCK: u64 = 399;
const JUST: u64 = 398;
const JUST_REST: u64 = 2;

struct World {
    env: Env,
    market: Market,
    trader: Trader,
    partner: Pubkey,
}

fn world() -> TestResult<World> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(anchor_spl::token::ID, &[], anchor_spl::token::ID, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    Ok(World {
        env,
        market,
        trader,
        partner: Pubkey::new_unique(),
    })
}

fn proof_spec(
    nonce: u64,
    attestor: &Pubkey,
    judge_fee: u64,
    partner: &Pubkey,
) -> TestResult<IntentSpec> {
    Ok(IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: ESCROW,
            min_result: 1,
            max_result: 1,
            attestor: attestor.to_bytes(),
            spec_hash: SPEC,
            judge_fee,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ext: partner_ext(partner, PARTNER_BPS),
        ..swap_spec(nonce, ESCROW)?
    })
}

fn settles(env: &Env, judge_fee: u64) -> TestResult<bool> {
    let config = env.config()?;
    assert_eq!(config.kind_fee_mask, 0);
    Ok(release_settles(
        ESCROW,
        judge_fee,
        config.fee_bps,
        PARTNER_BPS,
        config.partner_cut_bps,
    ))
}

#[test]
fn the_boundary_cases_sit_on_either_side_of_settling() -> TestResult {
    let w = world()?;
    assert!(!settles(&w.env, STUCK)?);
    assert!(settles(&w.env, JUST)?);
    Ok(())
}

#[test]
fn an_owner_cannot_open_a_proof_escrow_no_release_can_settle() -> TestResult {
    let mut w = world()?;
    let attestor = Keypair::new();
    let owner = w.trader.key.pubkey();
    let stuck = proof_spec(0, &attestor.pubkey(), STUCK, &w.partner)?;
    assert_eq!(
        w.env.create_intent(&w.trader, &w.market, &stuck).err(),
        Some(engine_error(EngineError::ReleaseCannotSettle))
    );
    assert_eq!(w.env.balance(&w.trader.input)?, FUNDED);
    assert!(!w.env.exists(&intent_pda(&owner, 0)));

    let just = proof_spec(0, &attestor.pubkey(), JUST, &w.partner)?;
    w.env.create_intent(&w.trader, &w.market, &just)?;
    let intent = intent_pda(&owner, 0);
    assert_eq!(w.env.balance(&vault_pda(&intent))?, ESCROW);

    let solver = w.env.solver(&w.market, 0)?;
    let fee_to = w.env.fee_account(&w.market)?;
    let partner_to = w
        .env
        .create_ata(&w.partner, &w.market.input_mint, w.market.input_program)?;
    let judge_to = w.env.create_ata(
        &attestor.pubkey(),
        &w.market.input_mint,
        w.market.input_program,
    )?;
    w.env.partner_to = Some(partner_to);
    w.env.judge_to = Some(judge_to);
    let payee = solver.input;
    let message =
        attestation_proof_message(DOMAIN, &attestor.pubkey(), &intent, &payee, ESCROW, 1, SPEC);
    let fill = w.env.fill_attested_ix(
        &solver.key.pubkey(),
        &owner,
        &w.market,
        0,
        &payee,
        Some(&fee_to),
        1,
    );
    w.env
        .send(&solver.key, &[ed25519_ix(&attestor, &message), fill], &[])?;
    assert_eq!(w.env.balance(&judge_to)?, JUST);
    let rest = [fee_to, partner_to, payee]
        .iter()
        .map(|a| w.env.balance(a))
        .sum::<TestResult<u64>>()?;
    assert_eq!(rest, JUST_REST);
    assert_eq!(w.env.balance(&vault_pda(&intent))?, 0);
    Ok(())
}

#[test]
fn a_relayer_cannot_open_a_signed_proof_escrow_no_release_can_settle() -> TestResult {
    let mut w = world()?;
    let attestor = Pubkey::new_unique();
    w.env.approve_delegate(&w.trader, &w.market, FUNDED)?;
    let relayer = w.env.funded()?;
    let owner = w.trader.key.pubkey();
    let stuck = proof_spec(3, &attestor, STUCK, &w.partner)?;
    let signed = ed25519_ix(
        &w.trader.key,
        &w.env
            .signed_message(&w.trader, &w.market, &stuck, DOMAIN, SUBMIT_BY),
    );
    let create = w
        .env
        .create_signed_ix(&relayer.pubkey(), &w.trader, &w.market, &stuck, SUBMIT_BY);
    assert_eq!(
        w.env.send(&relayer, &[signed, create], &[]).err(),
        Some(engine_error_at(1, EngineError::ReleaseCannotSettle))
    );
    assert_eq!(w.env.balance(&w.trader.input)?, FUNDED);

    let just = proof_spec(3, &attestor, JUST, &w.partner)?;
    let signed = ed25519_ix(
        &w.trader.key,
        &w.env
            .signed_message(&w.trader, &w.market, &just, DOMAIN, SUBMIT_BY),
    );
    let create = w
        .env
        .create_signed_ix(&relayer.pubkey(), &w.trader, &w.market, &just, SUBMIT_BY);
    w.env.send(&relayer, &[signed, create], &[])?;
    assert_eq!(w.env.balance(&vault_pda(&intent_pda(&owner, 3)))?, ESCROW);
    Ok(())
}

#[test]
fn an_owner_cannot_open_a_committee_escrow_no_release_can_settle() -> TestResult {
    let mut w = world()?;
    let members = sorted_members(3);
    let keys: Vec<Pubkey> = members.iter().map(Signer::pubkey).collect();
    let payer = w.env.funded()?;
    let (ix, committee) = create_committee_ix(&payer.pubkey(), &keys, 2, &Pubkey::new_unique())?;
    w.env.send(&payer, &[ix], &[])?;
    let owner = w.trader.key.pubkey();
    let stuck = proof_spec(5, &committee, STUCK, &w.partner)?;
    assert_eq!(
        w.env.create_intent(&w.trader, &w.market, &stuck).err(),
        Some(engine_error(EngineError::ReleaseCannotSettle))
    );
    let just = proof_spec(5, &committee, JUST, &w.partner)?;
    w.env.create_intent(&w.trader, &w.market, &just)?;
    assert_eq!(w.env.balance(&vault_pda(&intent_pda(&owner, 5)))?, ESCROW);
    Ok(())
}

#[test]
fn an_agent_cannot_open_any_proof_escrow_settling_or_not() -> TestResult {
    let mut w = world()?;
    w.env.approve_delegate(&w.trader, &w.market, FUNDED)?;
    let agent = w.env.funded()?;
    let mut terms = mandate_terms(agent.pubkey(), START_TS + 86_400);
    terms.partner = w.partner;
    terms.partner_bps = PARTNER_BPS;
    let grant = w.env.create_mandate_ix(&w.trader, &w.market, terms);
    let owner = w.trader.key.insecure_clone();
    w.env.send(&owner, &[grant], &[])?;
    let mandate = mandate_pda(&owner.pubkey(), &agent.pubkey(), 0);
    for judge_fee in [STUCK, JUST] {
        let spec = proof_spec(
            agent_lane(1, 0),
            &Pubkey::new_unique(),
            judge_fee,
            &w.partner,
        )?;
        let ix = w
            .env
            .agent_intent_ix(&agent.pubkey(), mandate, &w.trader, &w.market, &spec);
        assert_eq!(
            w.env.send(&agent, &[ix], &[]).err(),
            Some(engine_error(EngineError::MandateKind))
        );
    }
    assert_eq!(w.env.balance(&w.trader.input)?, FUNDED);
    Ok(())
}
