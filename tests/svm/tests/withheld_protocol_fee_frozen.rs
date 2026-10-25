use svm_tests::{MintExt, ReleasePath, ReleaseTerms, ReleaseWorld, Setting, TestResult, START_TS};

const T22: anchor_lang::prelude::Pubkey = anchor_spl::token_2022::ID;
const MINT: [MintExt; 3] = [
    MintExt::InterestBearing,
    MintExt::MetadataPointer,
    MintExt::Freezable,
];
const ESCROW: u64 = 100_000;
const JUDGE_FEE: u64 = 1_234;
const PROTOCOL_FEE: u64 = 50;
const NET: u64 = 98_716;
const SHARES: [u64; 2] = [59_230, 39_486];
const TERMS: ReleaseTerms = ReleaseTerms {
    funded: 1_000_000,
    escrow: ESCROW,
    judge_fee: JUDGE_FEE,
    spec: [0x5d; 32],
    weights: [6_000, 4_000],
    partner_bps: 0,
};
const SETTING: Setting = Setting::Frozen;

fn the_workers_and_judge_are_paid(path: ReleasePath) -> TestResult {
    let mut w = ReleaseWorld::new(&MINT, path, TERMS)?;
    let announcer = w.workers[0].insecure_clone();
    let intent = w.intent();
    let delivery = w.env.announce_for(&announcer, &intent)?;
    w.env.set_now(START_TS + 1_800);
    let (fee_owner, fee_to) = (w.fee_owner.insecure_clone(), w.fee_to);
    let mint = w.market.input_mint;
    w.env
        .apply_setting(&fee_owner, &fee_to, &mint, T22, SETTING)?;
    let result = w.release(path, &delivery)?;
    assert!(result.is_ok(), "{path:?}: {:?}", result.err());
    let expected = if path.split() { SHARES } else { [NET, 0] };
    assert_eq!(w.paid()?, expected, "workers");
    assert_eq!(w.env.balance(&w.judge_to)?, JUDGE_FEE, "judge fee");
    assert_eq!(w.env.balance(&fee_to)?, 0, "the blocking fee account");
    assert_eq!(
        w.env.balance(&w.vault())?,
        PROTOCOL_FEE,
        "only the protocol fee stays"
    );
    Ok(())
}

#[test]
fn a_protocol_fee_account_frozen_by_the_issuer_does_not_stop_any_release_paying_its_workers_and_judge(
) -> TestResult {
    for path in [
        ReleasePath::Attested,
        ReleasePath::AttestedSplit,
        ReleasePath::Committee,
        ReleasePath::CommitteeSplit,
    ] {
        the_workers_and_judge_are_paid(path)?;
    }
    Ok(())
}
