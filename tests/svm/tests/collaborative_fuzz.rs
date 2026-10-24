use anchor_lang::prelude::Pubkey;
use intent_core::bounty::split_n;
use intent_core::fee::{release_settles, split_fees};
use intent_core::kinds::{attested_result, Kind};
use intent_engine::errors::EngineError;
use intent_engine::state::MAX_FEE_BPS;
use intent_engine::Economics;
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;
use svm_tests::{
    anchor_error_at, cosign_batch_ix, engine_error, intent_pda, partner_ext, split_commit,
    split_digest, swap_spec, vault_pda, Env, IntentSpec, TestResult, DOMAIN,
};

const SMALL: u64 = 10_000;
const LARGEST: u64 = u64::MAX / 2;
const FEE_BPS: u16 = 5;
const SPEC: [u8; 32] = [0x5e; 32];

#[derive(Debug, Clone)]
struct Case {
    escrow: u64,
    weights: Vec<u16>,
    slots: Vec<usize>,
    judge_fee: u64,
    partner: Option<(u16, u16)>,
}

fn proof_spec(attestor: &Keypair, case: &Case, ext: Vec<u8>) -> TestResult<IntentSpec> {
    Ok(IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: case.escrow,
            min_result: 1,
            max_result: 1,
            attestor: attestor.pubkey().to_bytes(),
            spec_hash: SPEC,
            judge_fee: case.judge_fee,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ext,
        ..swap_spec(0, case.escrow)?
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

fn escrow() -> impl Strategy<Value = u64> {
    prop_oneof![1u64..SMALL, SMALL..=LARGEST, Just(LARGEST)]
}

fn slots(n: usize) -> BoxedStrategy<Vec<usize>> {
    let distinct: Vec<usize> = (0..n).collect();
    prop_oneof![
        3 => Just(distinct),
        1 => prop::collection::vec(0..n, n),
    ]
    .boxed()
}

fn split_case() -> impl Strategy<Value = Case> {
    (1usize..=8)
        .prop_flat_map(|n| {
            (
                escrow(),
                prop::collection::vec(0u16..=10_000, n.saturating_sub(1)),
                slots(n),
                prop::option::of(any::<u64>()),
                prop::option::of((1u16..=MAX_FEE_BPS - FEE_BPS, 0u16..=10_000)),
            )
        })
        .prop_map(|(escrow, cuts, slots, judge, partner)| Case {
            escrow,
            weights: weights_from_cuts(&cuts),
            slots,
            judge_fee: judge.map_or(0, |j| j.checked_rem(escrow).unwrap_or(0)),
            partner,
        })
}

fn has_duplicates(slots: &[usize]) -> bool {
    slots
        .iter()
        .enumerate()
        .any(|(i, s)| slots.iter().skip(i.saturating_add(1)).any(|t| t == s))
}

fn run_split(case: &Case) -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(anchor_spl::token::ID, &[], anchor_spl::token::ID, &[])?;
    let program = market.input_program;
    let (partner_bps, cut_bps) = case.partner.unwrap_or((0, 0));
    let admin = env.authority.insecure_clone();
    let economics = env.economics_ix(
        &admin.pubkey(),
        Economics {
            kind_fee_mask: 0,
            kind_fee_bps: [0; 4],
            partner_cut_bps: cut_bps,
            crank_bounty: 0,
            create_fee: 0,
        },
    );
    env.send(&admin, &[economics], &[])?;
    let trader = env.trader(&market, case.escrow)?;
    let owner = trader.key.pubkey();
    let attestor = Keypair::new();
    let partner = Pubkey::new_unique();
    let partner_to = env.create_ata(&partner, &market.input_mint, program)?;
    let ext = if case.partner.is_some() {
        env.partner_to = Some(partner_to);
        partner_ext(&partner, partner_bps)
    } else {
        Vec::new()
    };
    let created = env.create_intent(&trader, &market, &proof_spec(&attestor, case, ext)?);
    if !release_settles(case.escrow, case.judge_fee, FEE_BPS, partner_bps, cut_bps) {
        if created.err() != Some(engine_error(EngineError::ReleaseCannotSettle)) {
            return Err("an escrow no release can settle was not refused at creation".into());
        }
        if env.balance(&trader.input)? != case.escrow {
            return Err("a refused creation moved escrow".into());
        }
        return Ok(());
    }
    created?;
    let intent = intent_pda(&owner, 0);
    let vault = vault_pda(&intent);
    let judge_to = env.create_ata(&attestor.pubkey(), &market.input_mint, program)?;
    env.judge_to = Some(judge_to);
    let solver = env.solver(&market, 0)?;
    let fee_to = env.fee_account(&market)?;
    let wallets: Vec<Keypair> = (0..case.weights.len()).map(|_| Keypair::new()).collect();
    let mut atas = Vec::new();
    for w in &wallets {
        atas.push(env.create_ata(&w.pubkey(), &market.input_mint, program)?);
    }
    let mut chosen: Vec<&Keypair> = Vec::new();
    for &slot in &case.slots {
        chosen.push(wallets.get(slot).ok_or("slot out of range")?);
    }
    let recipients: Vec<Pubkey> = chosen.iter().map(|k| k.pubkey()).collect();
    let fee_before = env.balance(&fee_to)?;
    let split_hash = split_commit(&recipients, &case.weights);
    let delivery = env.announce_as(chosen.first().ok_or("no recipient")?, &intent)?;
    let digest = split_digest(DOMAIN, &intent, case.escrow, 1, SPEC, split_hash, &delivery);
    let fill = env.fill_attested_split_ix(
        &solver.key.pubkey(),
        &owner,
        &market,
        0,
        &recipients,
        &case.weights,
        Some(&fee_to),
        1,
    );
    let signers: Vec<&Keypair> = chosen
        .iter()
        .copied()
        .chain(std::iter::once(&attestor))
        .collect();
    let ixs: Vec<Instruction> = vec![cosign_batch_ix(&signers, &digest)?, fill];
    let sent = env.send(&solver.key, &ixs, &[]);
    let protocol = env
        .balance(&fee_to)?
        .checked_sub(fee_before)
        .ok_or("protocol fee balance went backwards")?;
    let partner_paid = env.balance(&partner_to)?;
    let judge_paid = env.balance(&judge_to)?;
    let mut paid = Vec::new();
    for a in &atas {
        paid.push(env.balance(a)?);
    }
    let left = env.balance(&vault)?;
    let total = paid
        .iter()
        .chain([protocol, partner_paid, judge_paid, left].iter())
        .try_fold(0u64, |sum, v| sum.checked_add(*v))
        .ok_or("accounting overflowed")?;
    if total != case.escrow {
        return Err(format!(
            "conservation {paid:?} + {protocol} + {partner_paid} + {judge_paid} + {left} != {}",
            case.escrow
        )
        .into());
    }
    if has_duplicates(&case.slots) {
        let refused = anchor_error_at(
            1,
            anchor_lang::error::ErrorCode::ConstraintDuplicateMutableAccount,
        );
        if sent.err() != Some(refused) {
            return Err("a split naming a recipient twice was not refused".into());
        }
        if left != case.escrow {
            return Err("a refused split moved escrow".into());
        }
        return Ok(());
    }
    let settle = case
        .escrow
        .checked_sub(case.judge_fee)
        .ok_or("judge fee above escrow")?;
    let fees = split_fees(settle, FEE_BPS, partner_bps, cut_bps).map_err(|e| format!("{e:?}"))?;
    sent?;
    let plan = split_n(fees.net, &case.weights).map_err(|e| format!("{e:?}"))?;
    let mut by_slot = Vec::new();
    for &slot in &case.slots {
        by_slot.push(*paid.get(slot).ok_or("slot out of range")?);
    }
    if by_slot.as_slice() != plan.as_slice() {
        return Err(format!("payout {by_slot:?} != weighted plan {:?}", plan.as_slice()).into());
    }
    if (protocol, partner_paid, judge_paid, left)
        != (fees.protocol, fees.partner, case.judge_fee, 0)
    {
        return Err(format!(
            "fees {protocol} {partner_paid} {judge_paid} {left} != {fees:?} judge {}",
            case.judge_fee
        )
        .into());
    }
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(
        std::env::var("SPLIT_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(48)
    ))]

    #[test]
    fn a_split_pays_each_co_author_its_weighted_share_and_conserves_for_any_split(
        case in split_case(),
    ) {
        run_split(&case).map_err(|e| TestCaseError::fail(e.to_string()))?;
    }
}
