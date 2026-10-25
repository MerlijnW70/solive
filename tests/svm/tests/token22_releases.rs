use intent_core::bounty::split_n;
use intent_core::fee::split_fees;
use intent_engine::events::{StakeMoved, STAKE_TO_WORKER};
use solana_signer::Signer;
use svm_tests::{
    claims_pda, events, settle_claims_ix, vault_pda, MintExt, ReleasePath as Path, ReleaseTerms,
    ReleaseWorld, TestResult, START_TS,
};

const FUNDED: u64 = 1_000_000;
const ESCROW: u64 = 100_000;
const JUDGE_FEE: u64 = 1_234;
const PROTOCOL_FEE: u64 = 50;
const NET: u64 = 98_716;
const SHARES: [u64; 2] = [59_230, 39_486];
const WEIGHTS: [u16; 2] = [6_000, 4_000];
const SPEC: [u8; 32] = [0x5d; 32];
const STAKE: u64 = 50_000_000;
const HOUR: u32 = 3_600;
const EXTENSIONS: [&[MintExt]; 6] = [
    &[MintExt::InterestBearing],
    &[MintExt::ScaledUi],
    &[MintExt::MetadataPointer],
    &[MintExt::Freezable],
    &[
        MintExt::InterestBearing,
        MintExt::MetadataPointer,
        MintExt::Freezable,
    ],
    &[
        MintExt::ScaledUi,
        MintExt::MetadataPointer,
        MintExt::Freezable,
    ],
];

const TERMS: ReleaseTerms = ReleaseTerms {
    funded: FUNDED,
    escrow: ESCROW,
    judge_fee: JUDGE_FEE,
    spec: SPEC,
    weights: WEIGHTS,
    partner_bps: 0,
};

fn every_extension(path: Path, held: bool) -> TestResult {
    for exts in EXTENSIONS {
        settles(exts, path, held).map_err(|e| format!("{path:?} on {exts:?}: {e}"))?;
    }
    Ok(())
}

fn settles(exts: &[MintExt], path: Path, held: bool) -> TestResult {
    let mut w = ReleaseWorld::new(exts, path, TERMS)?;
    let owner = w.owner();
    let intent = w.intent();
    let board = claims_pda(&intent);
    let claimant = w.workers[0].pubkey();
    if held {
        let trader = w.trader.key.insecure_clone();
        let worker = w.workers[0].insecure_clone();
        w.env.hold_claim(&trader, 0, &worker, HOUR, STAKE)?;
        w.env.claims = Some(board);
        w.env.stake_to = Some(claimant);
    }
    let announcer = w.workers[0].insecure_clone();
    let delivery = w.env.announce_for(&announcer, &intent)?;
    w.env.set_now(START_TS + 1_800);
    assert_eq!(w.env.balance(&vault_pda(&intent))?, ESCROW);
    assert_eq!(w.env.balance(&w.fee_to)?, 0);
    assert_eq!(w.env.balance(&w.judge_to)?, 0);
    assert_eq!(w.paid()?, [0, 0]);
    let claimant_before = w.env.lamports(&claimant);
    let board_before = w.env.lamports(&board);

    let meta = w.release(path, &delivery)??;

    let expected = if path.split() { SHARES } else { [NET, 0] };
    assert_eq!(w.paid()?, expected, "workers");
    assert_eq!(w.env.balance(&w.judge_to)?, JUDGE_FEE, "judge fee");
    assert_eq!(w.env.balance(&w.fee_to)?, PROTOCOL_FEE, "protocol fee");
    assert_eq!(w.env.balance(&vault_pda(&intent))?, 0, "vault emptied");
    assert_eq!(w.env.balance(&w.trader.input)?, FUNDED - ESCROW);
    let moved: Vec<_> = events::<StakeMoved>(&meta)
        .into_iter()
        .map(|e| (e.worker, e.to, e.amount, e.role))
        .collect();
    if held {
        assert_eq!(moved, [(claimant, claimant, STAKE, STAKE_TO_WORKER)]);
        assert_eq!(
            w.env.lamports(&claimant).checked_sub(claimant_before),
            Some(STAKE),
            "stake"
        );
        assert_eq!(
            board_before.checked_sub(w.env.lamports(&board)),
            Some(STAKE)
        );
    } else {
        assert!(moved.is_empty());
        assert_eq!(w.env.lamports(&claimant), claimant_before);
        assert!(!w.env.exists(&board));
    }

    let rents = w.env.rents(&owner, 0)?;
    let rent_payer = w.env.lamports(&owner);
    let cranker = w.env.funded()?;
    let close = w
        .env
        .close_ix_by(&cranker.pubkey(), &owner, &w.market, 0, &w.trader.input);
    w.env.send(&cranker, &[close], &[])?;
    assert!(!w.env.exists(&vault_pda(&intent)), "vault closed");
    assert!(!w.env.exists(&intent), "intent closed");
    assert!(rents.vault > 0 && rents.intent > rents.bounty);
    assert_eq!(
        w.env.lamports(&owner).checked_sub(rent_payer),
        rents
            .vault
            .checked_add(rents.intent)
            .and_then(|r| r.checked_sub(rents.bounty)),
        "rent returned"
    );
    assert_eq!(w.env.balance(&w.trader.input)?, FUNDED - ESCROW);

    if held {
        let board_rent = w.env.lamports(&board);
        let before = w.env.lamports(&owner);
        w.env
            .send(&cranker, &[settle_claims_ix(&intent, &owner, None)], &[])?;
        assert!(!w.env.exists(&board), "board closed");
        assert_eq!(
            w.env.lamports(&owner).checked_sub(before),
            Some(board_rent),
            "board rent"
        );
        assert_eq!(
            w.env.lamports(&claimant).checked_sub(claimant_before),
            Some(STAKE)
        );
    }
    Ok(())
}

#[test]
fn the_expected_amounts_follow_the_fee_and_split_rules() -> TestResult {
    let fees = split_fees(ESCROW - JUDGE_FEE, 5, 0, 0).map_err(|e| format!("{e:?}"))?;
    assert_eq!(
        (fees.protocol, fees.partner, fees.net),
        (PROTOCOL_FEE, 0, NET)
    );
    let plan = split_n(NET, &WEIGHTS).map_err(|e| format!("{e:?}"))?;
    assert_eq!(plan.as_slice(), SHARES.as_slice());
    assert_eq!(JUDGE_FEE + PROTOCOL_FEE + NET, ESCROW);
    Ok(())
}

#[test]
fn attested_releases_pay_to_the_base_unit_on_every_allowed_extension() -> TestResult {
    every_extension(Path::Attested, false)
}

#[test]
fn attested_split_releases_pay_to_the_base_unit_on_every_allowed_extension() -> TestResult {
    every_extension(Path::AttestedSplit, false)
}

#[test]
fn committee_releases_pay_to_the_base_unit_on_every_allowed_extension() -> TestResult {
    every_extension(Path::Committee, false)
}

#[test]
fn committee_split_releases_pay_to_the_base_unit_on_every_allowed_extension() -> TestResult {
    every_extension(Path::CommitteeSplit, false)
}

#[test]
fn attested_releases_return_a_held_stake_to_the_claimant_on_every_allowed_extension() -> TestResult
{
    every_extension(Path::Attested, true)
}

#[test]
fn attested_split_releases_return_a_held_stake_to_the_claimant_on_every_allowed_extension(
) -> TestResult {
    every_extension(Path::AttestedSplit, true)
}

#[test]
fn committee_releases_return_a_held_stake_to_the_claimant_on_every_allowed_extension() -> TestResult
{
    every_extension(Path::Committee, true)
}

#[test]
fn committee_split_releases_return_a_held_stake_to_the_claimant_on_every_allowed_extension(
) -> TestResult {
    every_extension(Path::CommitteeSplit, true)
}
