use anchor_lang::prelude::Pubkey;
use intent_core::bounty::split_n;
use intent_core::kinds::{attested_result, Kind};
use intent_engine::errors::EngineError;
use intent_engine::events::{FeeWithheld, WITHHELD_JUDGE};
use litesvm::types::TransactionMetadata;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;
use svm_tests::{
    cosign_batch_ix, engine_error_at, events, intent_pda, split_commit, split_digest, swap_spec,
    vault_pda, Env, IntentSpec, Market, MintExt, TestResult, Trader, DOMAIN,
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
    judged_spec(attestor, spec_hash, 0)
}

fn judged_spec(attestor: &Keypair, spec_hash: [u8; 32], judge_fee: u64) -> TestResult<IntentSpec> {
    Ok(IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: ESCROW,
            min_result: 1,
            max_result: 1,
            attestor: attestor.pubkey().to_bytes(),
            spec_hash,
            judge_fee,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ..swap_spec(0, ESCROW)?
    })
}

#[test]
fn a_collaborative_claim_pays_every_co_author_who_signed_the_split_and_conserves() -> TestResult {
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
    let fee_before = env.balance(&fee_to)?;
    let split_hash = split_commit(&recipients, &weights);
    let digest = split_digest(DOMAIN, &intent, ESCROW, 1, SPEC, split_hash);
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
    let signers: Vec<&Keypair> = coauthors.iter().chain(std::iter::once(&attestor)).collect();
    let ixs: Vec<Instruction> = vec![cosign_batch_ix(&signers, &digest)?, fill];
    env.send(&solver.key, &ixs, &[])?;
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
fn a_collaborative_claim_rejects_a_split_a_co_author_did_not_sign() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    let attestor = Keypair::new();
    const SPEC: [u8; 32] = [0x5e; 32];
    let coauthors = [Keypair::new(), Keypair::new(), Keypair::new()];
    let recipients: Vec<Pubkey> = coauthors.iter().map(Signer::pubkey).collect();
    let signed = [4000u16, 3500, 2500];
    let tampered = [8000u16, 1000, 1000];
    env.create_intent(&trader, &market, &proof_spec(&attestor, SPEC)?)?;
    let intent = intent_pda(&owner, 0);
    let solver = env.solver(&market, 0)?;
    let fee_to = env.fee_account(&market)?;
    for r in &recipients {
        env.create_ata(r, &market.input_mint, market.input_program)?;
    }
    let split_hash = split_commit(&recipients, &signed);
    let digest = split_digest(DOMAIN, &intent, ESCROW, 1, SPEC, split_hash);
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
    let signers: Vec<&Keypair> = coauthors.iter().chain(std::iter::once(&attestor)).collect();
    let ixs: Vec<Instruction> = vec![cosign_batch_ix(&signers, &digest)?, fill];
    let fill_index = u8::try_from(ixs.len().saturating_sub(1))?;
    assert_eq!(
        env.send(&solver.key, &ixs, &[]).err(),
        Some(engine_error_at(fill_index, EngineError::SigMessage)),
        "a split the co-authors signed cannot be swapped for a different one"
    );
    assert_eq!(
        env.balance(&vault_pda(&intent))?,
        ESCROW,
        "the escrow is untouched after the rejected claim"
    );
    Ok(())
}

#[test]
fn a_split_is_rejected_unless_the_batch_is_exactly_the_co_authors_then_the_attestor() -> TestResult
{
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    let attestor = Keypair::new();
    let stranger = Keypair::new();
    const SPEC: [u8; 32] = [0x5e; 32];
    let coauthors = [Keypair::new(), Keypair::new(), Keypair::new()];
    let recipients: Vec<Pubkey> = coauthors.iter().map(Signer::pubkey).collect();
    let weights = [4000u16, 3500, 2500];
    let [a, b, c] = &coauthors;
    env.create_intent(&trader, &market, &proof_spec(&attestor, SPEC)?)?;
    let intent = intent_pda(&owner, 0);
    let solver = env.solver(&market, 0)?;
    let fee_to = env.fee_account(&market)?;
    for r in &recipients {
        env.create_ata(r, &market.input_mint, market.input_program)?;
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
    let fill = claim(&env);
    let short: Vec<Instruction> = vec![cosign_batch_ix(&[a, b, &attestor], &digest)?, fill];
    assert_eq!(
        env.send(&solver.key, &short, &[]).err(),
        Some(engine_error_at(1, EngineError::SigHeader)),
        "a co-author left out of the batch is rejected"
    );
    let fill = claim(&env);
    let impostor: Vec<Instruction> = vec![cosign_batch_ix(&[a, b, c, &stranger], &digest)?, fill];
    assert_eq!(
        env.send(&solver.key, &impostor, &[]).err(),
        Some(engine_error_at(1, EngineError::SigPubkey)),
        "a stranger signing in the attestor's place is rejected"
    );
    let fill = claim(&env);
    let reordered: Vec<Instruction> = vec![cosign_batch_ix(&[b, a, c, &attestor], &digest)?, fill];
    assert_eq!(
        env.send(&solver.key, &reordered, &[]).err(),
        Some(engine_error_at(1, EngineError::SigPubkey)),
        "the co-authors signed out of their committed order is rejected"
    );
    assert_eq!(
        env.balance(&vault_pda(&intent))?,
        ESCROW,
        "the escrow is untouched after every rejected claim"
    );
    let fill = claim(&env);
    let honest: Vec<Instruction> = vec![cosign_batch_ix(&[a, b, c, &attestor], &digest)?, fill];
    env.send(&solver.key, &honest, &[])?;
    assert_eq!(
        env.balance(&vault_pda(&intent))?,
        0,
        "the exact co-author batch settles and drains the escrow"
    );
    Ok(())
}

const DONATION: u64 = 7;

fn donate(env: &mut Env, market: &Market, vault: &Pubkey, amount: u64) -> TestResult {
    let donor = env.funded()?;
    let from = env.create_ata(&donor.pubkey(), &market.input_mint, market.input_program)?;
    env.mint_to(&market.input_mint, &from, market.input_program, amount)?;
    env.transfer(
        &donor,
        &from,
        &market.input_mint,
        vault,
        market.input_program,
        amount,
    )
}

struct Claimed {
    atas: Vec<Pubkey>,
    weights: [u16; 3],
    meta: TransactionMetadata,
}

fn claim_split(
    env: &mut Env,
    market: &Market,
    owner: &Pubkey,
    attestor: &Keypair,
    spec_hash: [u8; 32],
) -> TestResult<Claimed> {
    let intent = intent_pda(owner, 0);
    let coauthors = [Keypair::new(), Keypair::new(), Keypair::new()];
    let recipients: Vec<Pubkey> = coauthors.iter().map(Signer::pubkey).collect();
    let weights = [4000u16, 3500, 2500];
    let solver = env.solver(market, 0)?;
    let fee_to = env.fee_account(market)?;
    let mut atas = Vec::new();
    for r in &recipients {
        atas.push(env.create_ata(r, &market.input_mint, market.input_program)?);
    }
    let split_hash = split_commit(&recipients, &weights);
    let digest = split_digest(DOMAIN, &intent, ESCROW, 1, spec_hash, split_hash);
    let fill = env.fill_attested_split_ix(
        &solver.key.pubkey(),
        owner,
        market,
        0,
        &recipients,
        &weights,
        Some(&fee_to),
        1,
    );
    let signers: Vec<&Keypair> = coauthors.iter().chain(std::iter::once(attestor)).collect();
    let ixs: Vec<Instruction> = vec![cosign_batch_ix(&signers, &digest)?, fill];
    let meta = env.send(&solver.key, &ixs, &[])?;
    Ok(Claimed {
        atas,
        weights,
        meta,
    })
}

#[test]
fn split_pays_out_after_a_donation_to_the_vault() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    let attestor = Keypair::new();
    const SPEC: [u8; 32] = [0x5e; 32];
    env.create_intent(&trader, &market, &proof_spec(&attestor, SPEC)?)?;
    let vault = vault_pda(&intent_pda(&owner, 0));
    donate(&mut env, &market, &vault, DONATION)?;
    assert_eq!(env.balance(&vault)?, ESCROW + DONATION);
    let fee_to = env.fee_account(&market)?;
    let fee_before = env.balance(&fee_to)?;
    let Claimed { atas, weights, .. } = claim_split(&mut env, &market, &owner, &attestor, SPEC)?;
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
        "each co-author receives its weighted share despite the donation"
    );
    assert_eq!(net + protocol, ESCROW, "only the escrow is paid out");
    assert_eq!(
        env.balance(&vault)?,
        DONATION,
        "the donation stays in the vault"
    );
    Ok(())
}

#[test]
fn split_pays_out_when_the_judge_fee_is_withheld() -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(
        anchor_spl::token::ID,
        &[MintExt::Freezable],
        anchor_spl::token::ID,
        &[],
    )?;
    let trader = env.trader(&market, FUNDED)?;
    let owner = trader.key.pubkey();
    let attestor = Keypair::new();
    const SPEC: [u8; 32] = [0x6d; 32];
    const JF: u64 = 40;
    env.create_intent(&trader, &market, &judged_spec(&attestor, SPEC, JF)?)?;
    let vault = vault_pda(&intent_pda(&owner, 0));
    let judge_ata = env.create_ata(&attestor.pubkey(), &market.input_mint, market.input_program)?;
    env.set_frozen(&judge_ata, &market.input_mint, market.input_program, true)?;
    env.judge_to = Some(judge_ata);
    let fee_to = env.fee_account(&market)?;
    let fee_before = env.balance(&fee_to)?;
    let Claimed {
        atas,
        weights,
        meta,
    } = claim_split(&mut env, &market, &owner, &attestor, SPEC)?;
    let withheld: Vec<_> = events::<FeeWithheld>(&meta)
        .into_iter()
        .map(|e| (e.payee, e.account, e.fee, e.role))
        .collect();
    assert_eq!(
        withheld,
        [(attestor.pubkey(), judge_ata, JF, WITHHELD_JUDGE)]
    );
    assert_eq!(
        env.balance(&judge_ata)?,
        0,
        "the frozen judge account receives nothing"
    );
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
        "each co-author receives its weighted share"
    );
    assert_eq!(net + protocol, ESCROW - JF, "the co-authors split the rest");
    assert_eq!(
        env.balance(&vault)?,
        JF,
        "the withheld judge fee stays in the vault"
    );
    let before = env.balance(&trader.input)?;
    let cranker = env.funded()?;
    let close = env.close_ix_by(&cranker.pubkey(), &owner, &market, 0, &trader.input);
    env.send(&cranker, &[close], &[])?;
    assert_eq!(
        env.balance(&trader.input)?,
        before + JF,
        "the owner recovers the withheld judge fee on close"
    );
    Ok(())
}

#[test]
fn split_donation_is_swept_to_the_owner_on_close() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    let attestor = Keypair::new();
    const SPEC: [u8; 32] = [0x5f; 32];
    env.create_intent(&trader, &market, &proof_spec(&attestor, SPEC)?)?;
    let intent = intent_pda(&owner, 0);
    let vault = vault_pda(&intent);
    donate(&mut env, &market, &vault, DONATION)?;
    claim_split(&mut env, &market, &owner, &attestor, SPEC)?;
    assert_eq!(env.balance(&vault)?, DONATION);
    let before = env.balance(&trader.input)?;
    let cranker = env.funded()?;
    let close = env.close_ix_by(&cranker.pubkey(), &owner, &market, 0, &trader.input);
    env.send(&cranker, &[close], &[])?;
    assert_eq!(
        env.balance(&trader.input)?,
        before + DONATION,
        "the owner receives the donation on close"
    );
    assert!(!env.exists(&intent), "the intent closes");
    assert!(!env.exists(&vault), "the vault closes");
    Ok(())
}
