use anchor_lang::prelude::Pubkey;
use intent_engine::errors::EngineError;
use intent_engine::state::{Announcement, HELD_CLAIM_SECS};
use intent_engine::SplitClaim;
use solana_signer::Signer;
use svm_tests::{
    close_announcement_ix, engine_error, load, Delivery, MintExt, ReleasePath, ReleaseTerms,
    ReleaseWorld, Setting, TestResult, START_TS,
};

const T22: Pubkey = anchor_spl::token_2022::ID;
const MINT: [MintExt; 3] = [
    MintExt::InterestBearing,
    MintExt::MetadataPointer,
    MintExt::Freezable,
];
const HELD_SHARE: u64 = 39_486;
const EXPIRES_AT: i64 = START_TS + 3_600;
const REFUTE_WINDOW: i64 = 30 * 86_400;
const TERMS: ReleaseTerms = ReleaseTerms {
    funded: 1_000_000,
    escrow: 100_000,
    judge_fee: 1_234,
    spec: [0x5d; 32],
    weights: [6_000, 4_000],
    partner_bps: 0,
};

fn held(path: ReleasePath, setting: Setting) -> TestResult<(ReleaseWorld, Delivery)> {
    let mut w = ReleaseWorld::new(&MINT, path, TERMS)?;
    let announcer = w.workers[0].insecure_clone();
    let intent = w.intent();
    let delivery = w.env.announce_for(&announcer, &intent)?;
    w.env.set_now(START_TS + 1_800);
    let (blocker, blocked) = (w.workers[1].insecure_clone(), w.atas[1]);
    let mint = w.market.input_mint;
    w.env
        .apply_setting(&blocker, &blocked, &mint, T22, setting)?;
    let result = w.release(path, &delivery)?;
    assert!(result.is_ok(), "{path:?}: {:?}", result.err());
    assert_eq!(w.env.balance(&w.vault())?, HELD_SHARE, "the held share");
    assert_eq!(
        w.env.intent(&w.owner(), 0)?.held,
        1,
        "the escrow holds a share"
    );
    let stored: Announcement = load(&w.env.svm, &delivery.announcement)?;
    assert_eq!(stored.held, 0b10, "the second recipient's bit");
    Ok((w, delivery))
}

fn split(w: &ReleaseWorld) -> SplitClaim {
    SplitClaim {
        recipients: w.wallets(),
        weights: TERMS.weights.to_vec(),
    }
}

fn claim(
    w: &mut ReleaseWorld,
    delivery: &Delivery,
    by: usize,
    index: u8,
    to: Pubkey,
    claim: SplitClaim,
) -> TestResult<Result<(), solana_transaction_error::TransactionError>> {
    let signer = w.workers.get(by).ok_or("no such worker")?.insecure_clone();
    let ix = w.claim_held_ix(&signer.pubkey(), &delivery.announcement, &to, index, claim);
    Ok(w.env.send(&signer, &[ix], &[]).map(|_| ()))
}

fn close(w: &mut ReleaseWorld) -> Result<(), solana_transaction_error::TransactionError> {
    let owner = w.trader.key.insecure_clone();
    let ix = w
        .env
        .close_ix(&owner.pubkey(), &w.market, 0, &w.trader.input);
    w.env.send(&owner, &[ix], &[]).map(|_| ())
}

#[test]
fn a_held_share_is_claimed_into_another_account_of_its_wallet_on_either_split_path() -> TestResult {
    for path in [ReleasePath::AttestedSplit, ReleasePath::CommitteeSplit] {
        let (mut w, delivery) = held(path, Setting::MemoRequired)?;
        let wallet = w.workers[1].pubkey();
        let other = w
            .env
            .create_token_account(&w.market.input_mint, &wallet, T22)?;
        let terms = split(&w);
        claim(&mut w, &delivery, 1, 1, other, terms)??;
        assert_eq!(w.env.balance(&other)?, HELD_SHARE, "{path:?}: claimed");
        assert_eq!(w.env.balance(&w.vault())?, 0, "{path:?}: vault emptied");
        assert_eq!(
            w.env.intent(&w.owner(), 0)?.held,
            0,
            "{path:?}: nothing held"
        );
        let stored: Announcement = load(&w.env.svm, &delivery.announcement)?;
        assert_eq!(stored.held, 0, "{path:?}: bit cleared");
    }
    Ok(())
}

#[test]
fn a_share_held_by_a_frozen_account_is_claimed_into_that_account_once_thawed() -> TestResult {
    let (mut w, delivery) = held(ReleasePath::AttestedSplit, Setting::Frozen)?;
    let (blocked, mint) = (w.atas[1], w.market.input_mint);
    w.env.set_frozen(&blocked, &mint, T22, false)?;
    let terms = split(&w);
    claim(&mut w, &delivery, 1, 1, blocked, terms)??;
    assert_eq!(w.env.balance(&blocked)?, HELD_SHARE);
    Ok(())
}

#[test]
fn only_the_wallet_at_the_held_index_claims_and_only_once() -> TestResult {
    let (mut w, delivery) = held(ReleasePath::AttestedSplit, Setting::MemoRequired)?;
    let announcer_ata = w.atas[0];
    let wallet = w.workers[1].pubkey();
    let other = w
        .env
        .create_token_account(&w.market.input_mint, &wallet, T22)?;
    let terms = split(&w);
    assert_eq!(
        claim(&mut w, &delivery, 0, 1, announcer_ata, terms.clone())?,
        Err(engine_error(EngineError::HeldSplitMismatch)),
        "another wallet at the held index"
    );
    assert_eq!(
        claim(&mut w, &delivery, 0, 0, announcer_ata, terms.clone())?,
        Err(engine_error(EngineError::NoShareHeld)),
        "an index that holds nothing"
    );
    claim(&mut w, &delivery, 1, 1, other, terms.clone())??;
    assert_eq!(
        claim(&mut w, &delivery, 1, 1, other, terms)?,
        Err(engine_error(EngineError::NoShareHeld)),
        "a second claim"
    );
    assert_eq!(w.env.balance(&other)?, HELD_SHARE);
    Ok(())
}

#[test]
fn a_claim_with_another_split_is_refused() -> TestResult {
    let (mut w, delivery) = held(ReleasePath::AttestedSplit, Setting::MemoRequired)?;
    let wallet = w.workers[1].pubkey();
    let other = w
        .env
        .create_token_account(&w.market.input_mint, &wallet, T22)?;
    let bent = SplitClaim {
        recipients: w.wallets(),
        weights: vec![1_000, 9_000],
    };
    assert_eq!(
        claim(&mut w, &delivery, 1, 1, other, bent)?,
        Err(engine_error(EngineError::HeldSplitMismatch))
    );
    assert_eq!(w.env.balance(&w.vault())?, HELD_SHARE);
    Ok(())
}

#[test]
fn the_owner_cannot_close_the_escrow_while_a_share_is_held_until_the_claim_window_passes(
) -> TestResult {
    let (mut w, _) = held(ReleasePath::AttestedSplit, Setting::MemoRequired)?;
    w.env.set_now(EXPIRES_AT + 1);
    assert_eq!(close(&mut w), Err(engine_error(EngineError::SharesHeld)));
    w.env.set_now(EXPIRES_AT + HELD_CLAIM_SECS - 1);
    assert_eq!(close(&mut w), Err(engine_error(EngineError::SharesHeld)));
    let before = w.env.balance(&w.trader.input)?;
    w.env.set_now(EXPIRES_AT + HELD_CLAIM_SECS);
    close(&mut w)?;
    assert_eq!(
        w.env.balance(&w.trader.input)?,
        before + HELD_SHARE,
        "an unclaimed share returns to the owner after the window"
    );
    Ok(())
}

#[test]
fn the_escrow_closes_once_its_held_share_is_claimed() -> TestResult {
    let (mut w, delivery) = held(ReleasePath::AttestedSplit, Setting::MemoRequired)?;
    let wallet = w.workers[1].pubkey();
    let other = w
        .env
        .create_token_account(&w.market.input_mint, &wallet, T22)?;
    let terms = split(&w);
    claim(&mut w, &delivery, 1, 1, other, terms)??;
    w.env.set_now(EXPIRES_AT + 1);
    close(&mut w)?;
    assert!(!w.env.exists(&w.intent()), "escrow closed");
    Ok(())
}

#[test]
fn the_paid_announcement_stays_while_its_escrow_holds_a_share() -> TestResult {
    let (mut w, delivery) = held(ReleasePath::AttestedSplit, Setting::MemoRequired)?;
    let announcer = w.workers[0].insecure_clone();
    let intent = w.intent();
    let paid_at: Announcement = load(&w.env.svm, &delivery.announcement)?;
    w.env.set_now(paid_at.paid_at + REFUTE_WINDOW + 1);
    let shut = close_announcement_ix(
        &announcer.pubkey(),
        &delivery.announcement,
        &intent,
        &announcer.pubkey(),
    );
    assert_eq!(
        w.env
            .send(&announcer, std::slice::from_ref(&shut), &[])
            .map(|_| ()),
        Err(engine_error(EngineError::SharesHeld))
    );
    let wallet = w.workers[1].pubkey();
    let other = w
        .env
        .create_token_account(&w.market.input_mint, &wallet, T22)?;
    let terms = split(&w);
    claim(&mut w, &delivery, 1, 1, other, terms)??;
    w.env.send(&announcer, &[shut], &[])?;
    assert!(!w.env.exists(&delivery.announcement), "announcement closed");
    Ok(())
}
