use anchor_lang::prelude::Pubkey;
use intent_core::bounty::split_n;
use intent_core::kinds::{attested_result, Kind};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;
use svm_tests::{
    ed25519_ix, intent_pda, split_commit, split_digest, split_envelope, swap_spec, vault_pda, Env,
    IntentSpec, TestResult, DOMAIN,
};

const FUNDED: u64 = 10_000;

fn proof_spec(attestor: &Keypair, spec_hash: [u8; 32], escrow: u64) -> TestResult<IntentSpec> {
    Ok(IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: escrow,
            min_result: 1,
            max_result: 1,
            attestor: attestor.pubkey().to_bytes(),
            spec_hash,
            judge_fee: 0,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ..swap_spec(0, escrow)?
    })
}

fn weights_from_cuts(cuts: &[u16]) -> Vec<u16> {
    let mut bounds = Vec::with_capacity(cuts.len().saturating_add(2));
    bounds.push(0u16);
    bounds.extend_from_slice(cuts);
    bounds.push(10_000u16);
    bounds.sort_unstable();
    let mut weights = Vec::with_capacity(bounds.len().saturating_sub(1));
    let mut prev = 0u16;
    for &bound in bounds.iter().skip(1) {
        weights.push(bound.saturating_sub(prev));
        prev = bound;
    }
    weights
}

fn split_case() -> impl Strategy<Value = (u64, Vec<u16>)> {
    (1usize..=8)
        .prop_flat_map(|n| {
            (
                1u64..FUNDED,
                prop::collection::vec(0u16..=10_000, n.saturating_sub(1)),
            )
        })
        .prop_map(|(escrow, cuts)| (escrow, weights_from_cuts(&cuts)))
}

fn run_split(escrow: u64, weights: &[u16]) -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(anchor_spl::token::ID, &[], anchor_spl::token::ID, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let owner = trader.key.pubkey();
    let attestor = Keypair::new();
    const SPEC: [u8; 32] = [0x5e; 32];
    let coauthors: Vec<Keypair> = (0..weights.len()).map(|_| Keypair::new()).collect();
    let recipients: Vec<Pubkey> = coauthors.iter().map(Signer::pubkey).collect();
    env.create_intent(&trader, &market, &proof_spec(&attestor, SPEC, escrow)?)?;
    let intent = intent_pda(&owner, 0);
    let solver = env.solver(&market, 0)?;
    let fee_to = env.fee_account(&market)?;
    let mut atas = Vec::new();
    for r in &recipients {
        atas.push(env.create_ata(r, &market.input_mint, market.input_program)?);
    }
    let fee_before = env.balance(&fee_to)?;
    let split_hash = split_commit(&recipients, weights);
    let digest = split_digest(DOMAIN, &intent, escrow, 1, SPEC, split_hash);
    let fill = env.fill_attested_split_ix(
        &solver.key.pubkey(),
        &owner,
        &market,
        0,
        &recipients,
        weights,
        Some(&fee_to),
        1,
    );
    let mut ixs: Vec<Instruction> = coauthors
        .iter()
        .map(|k| ed25519_ix(k, &split_envelope(&k.pubkey(), &digest)))
        .collect();
    ixs.push(ed25519_ix(
        &attestor,
        &split_envelope(&attestor.pubkey(), &digest),
    ));
    ixs.push(fill);
    env.send(&solver.key, &ixs, &[])?;
    let protocol = env
        .balance(&fee_to)?
        .checked_sub(fee_before)
        .ok_or("protocol fee balance went backwards")?;
    let mut paid = Vec::new();
    for a in &atas {
        paid.push(env.balance(a)?);
    }
    let net: u64 = paid.iter().sum();
    let plan = split_n(net, weights).map_err(|e| format!("{e:?}"))?;
    if paid.as_slice() != plan.as_slice() {
        return Err(format!("payout {paid:?} != weighted plan {:?}", plan.as_slice()).into());
    }
    if env.balance(&vault_pda(&intent))? != 0 {
        return Err("vault not drained after split".into());
    }
    if net.checked_add(protocol) != Some(escrow) {
        return Err(format!("conservation {net} + {protocol} != {escrow}").into());
    }
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(
        std::env::var("SPLIT_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(48)
    ))]

    #[test]
    fn a_split_pays_each_co_author_its_weighted_share_and_conserves_for_any_split(
        (escrow, weights) in split_case(),
    ) {
        run_split(escrow, &weights).map_err(|e| TestCaseError::fail(e.to_string()))?;
    }
}
