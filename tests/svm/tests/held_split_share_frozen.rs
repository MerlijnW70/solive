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
const ANNOUNCER_SHARE: u64 = 59_230;
const BLOCKED_SHARE: u64 = 39_486;
const TERMS: ReleaseTerms = ReleaseTerms {
    funded: 1_000_000,
    escrow: ESCROW,
    judge_fee: JUDGE_FEE,
    spec: [0x5d; 32],
    weights: [6_000, 4_000],
    partner_bps: 0,
};
const SETTING: Setting = Setting::Frozen;

fn the_other_recipients_are_paid(path: ReleasePath) -> TestResult {
    let mut w = ReleaseWorld::new(&MINT, path, TERMS)?;
    let announcer = w.workers[0].insecure_clone();
    let intent = w.intent();
    let delivery = w.env.announce_for(&announcer, &intent)?;
    w.env.set_now(START_TS + 1_800);
    let (blocker, blocked) = (w.workers[1].insecure_clone(), w.atas[1]);
    let mint = w.market.input_mint;
    w.env
        .apply_setting(&blocker, &blocked, &mint, T22, SETTING)?;
    let result = w.release(path, &delivery)?;
    assert!(result.is_ok(), "{path:?}: {:?}", result.err());
    assert_eq!(
        w.env.balance(&w.atas[0])?,
        ANNOUNCER_SHARE,
        "the announcer's share"
    );
    assert_eq!(w.env.balance(&w.judge_to)?, JUDGE_FEE, "judge fee");
    assert_eq!(w.env.balance(&w.fee_to)?, PROTOCOL_FEE, "protocol fee");
    assert_eq!(w.env.balance(&blocked)?, 0, "the blocking recipient");
    assert_eq!(
        w.env.balance(&w.vault())?,
        BLOCKED_SHARE,
        "only the blocked share stays"
    );
    Ok(())
}

#[test]
fn one_split_recipient_frozen_by_the_issuer_does_not_stop_the_attested_split_paying_the_others(
) -> TestResult {
    the_other_recipients_are_paid(ReleasePath::AttestedSplit)
}

#[test]
fn one_split_recipient_frozen_by_the_issuer_does_not_stop_the_committee_split_paying_the_others(
) -> TestResult {
    the_other_recipients_are_paid(ReleasePath::CommitteeSplit)
}
