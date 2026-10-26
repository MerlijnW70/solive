use anchor_lang::prelude::Pubkey;
use intent_core::delivery::REFUTE_WINDOW_SECS;
use intent_engine::errors::EngineError;
use intent_engine::state::HELD_CLAIM_SECS;
use intent_engine::SplitClaim;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    close_announcement_ix, engine_error, ClaimWorld, Delivery, MintExt, ReleasePath, ReleaseTerms,
    ReleaseWorld, Setting, TestResult, START_TS,
};

const T22: Pubkey = anchor_spl::token_2022::ID;
const MINT: [MintExt; 3] = [
    MintExt::InterestBearing,
    MintExt::MetadataPointer,
    MintExt::Freezable,
];
const PROTOCOL_FEE: u64 = 50;
const SHARES: [u64; 2] = [59_230, 39_486];
const JUDGE_FEE: u64 = 1_234;
const TERMS: ReleaseTerms = ReleaseTerms {
    funded: 1_000_000,
    escrow: 100_000,
    judge_fee: JUDGE_FEE,
    spec: [0x5d; 32],
    weights: [6_000, 4_000],
    partner_bps: 0,
};
const KEPT: u64 = TERMS.funded - TERMS.escrow;
const STAKE: u64 = 50_000_000;
const HOUR: u32 = 3_600;
const FAR: [i64; 4] = [
    i64::MAX,
    i64::MAX - HELD_CLAIM_SECS - 1,
    i64::MAX - HELD_CLAIM_SECS,
    i64::MAX - HELD_CLAIM_SECS + 1,
];

fn released(
    expires_at: i64,
    path: ReleasePath,
    setting: Setting,
    blocked: Option<usize>,
) -> TestResult<(ReleaseWorld, Delivery)> {
    let mut w = ReleaseWorld::expiring(&MINT, path, TERMS, expires_at)?;
    let announcer = w.workers[0].insecure_clone();
    let intent = w.intent();
    let delivery = w.env.announce_for(&announcer, &intent)?;
    w.env.set_now(START_TS + 1_800);
    let mint = w.market.input_mint;
    let (owner, account) = match blocked {
        Some(i) => (
            w.workers.get(i).ok_or("no such worker")?.insecure_clone(),
            *w.atas.get(i).ok_or("no such account")?,
        ),
        None => (w.fee_owner.insecure_clone(), w.fee_to),
    };
    w.env.apply_setting(&owner, &account, &mint, T22, setting)?;
    let result = w.release(path, &delivery)?;
    assert!(result.is_ok(), "{expires_at}: release: {:?}", result.err());
    Ok((w, delivery))
}

fn withheld_fee(expires_at: i64) -> TestResult<ReleaseWorld> {
    let (w, _) = released(
        expires_at,
        ReleasePath::AttestedSplit,
        Setting::MemoRequired,
        None,
    )?;
    assert_eq!(w.paid()?, SHARES, "{expires_at}: both co-authors paid");
    assert_eq!(
        w.env.balance(&w.judge_to)?,
        JUDGE_FEE,
        "{expires_at}: judge paid"
    );
    assert_eq!(
        w.env.balance(&w.vault())?,
        PROTOCOL_FEE,
        "{expires_at}: the withheld fee stays"
    );
    assert_eq!(
        w.env.intent(&w.owner(), 0)?.held,
        0,
        "{expires_at}: no share is held"
    );
    Ok(w)
}

fn held_share(expires_at: i64) -> TestResult<(ReleaseWorld, Delivery)> {
    let (w, delivery) = released(
        expires_at,
        ReleasePath::AttestedSplit,
        Setting::MemoRequired,
        Some(1),
    )?;
    assert_eq!(
        w.env.balance(&w.vault())?,
        SHARES[1],
        "{expires_at}: the held share"
    );
    assert_eq!(
        w.env.intent(&w.owner(), 0)?.held,
        1,
        "{expires_at}: one share held"
    );
    Ok((w, delivery))
}

fn close(w: &mut ReleaseWorld) -> Result<(), TransactionError> {
    let owner = w.trader.key.insecure_clone();
    let ix = w
        .env
        .close_ix(&owner.pubkey(), &w.market, 0, &w.trader.input);
    w.env.send(&owner, &[ix], &[]).map(|_| ())
}

fn close_by(w: &mut ReleaseWorld, cranker: &Keypair) -> Result<(), TransactionError> {
    let ix = w
        .env
        .close_ix_by(&cranker.pubkey(), &w.owner(), &w.market, 0, &w.trader.input);
    w.env.send(cranker, &[ix], &[]).map(|_| ())
}

fn claim_world(expires_at: i64) -> TestResult<ClaimWorld> {
    let terms = ReleaseTerms {
        judge_fee: 0,
        ..TERMS
    };
    let mut release = ReleaseWorld::expiring(&[], ReleasePath::Attested, terms, expires_at)?;
    let payer = release.env.funded()?;
    let cranker = release.env.funded()?;
    let mut w = ClaimWorld {
        release,
        payer,
        cranker,
        listed: false,
        delivery: None,
    };
    w.open(HOUR, STAKE, None).map_err(|e| format!("{e:?}"))?;
    Ok(w)
}

#[test]
fn a_filled_escrow_with_a_withheld_fee_closes_and_refunds_every_unit_at_every_far_expiry(
) -> TestResult {
    for expires_at in [START_TS + 3_600].into_iter().chain(FAR) {
        let mut w = withheld_fee(expires_at)?;
        close(&mut w).map_err(|e| format!("{expires_at}: close: {e:?}"))?;
        assert_eq!(
            w.env.balance(&w.trader.input)?,
            KEPT + PROTOCOL_FEE,
            "{expires_at}: the withheld fee returns to the owner"
        );
        assert_eq!(
            TERMS.funded,
            KEPT + PROTOCOL_FEE + SHARES[0] + SHARES[1] + JUDGE_FEE,
            "every base unit is accounted for"
        );
        assert!(
            !w.env.exists(&w.intent()),
            "{expires_at}: the escrow closes"
        );
        assert!(!w.env.exists(&w.vault()), "{expires_at}: the vault closes");
    }
    Ok(())
}

#[test]
fn a_held_share_keeps_a_far_escrow_open_until_its_window_passes_or_the_share_is_claimed(
) -> TestResult {
    for expires_at in FAR {
        let (mut w, delivery) = held_share(expires_at)?;
        let edge = expires_at.checked_add(HELD_CLAIM_SECS);
        match edge {
            Some(edge) => {
                w.env.set_now(edge - 1);
                assert_eq!(
                    close(&mut w),
                    Err(engine_error(EngineError::SharesHeld)),
                    "{expires_at}: a second before the window ends"
                );
                w.env.set_now(edge);
                close(&mut w).map_err(|e| format!("{expires_at}: close: {e:?}"))?;
                assert_eq!(
                    w.env.balance(&w.trader.input)?,
                    KEPT + SHARES[1],
                    "{expires_at}: the unclaimed share returns to the owner"
                );
            }
            None => {
                w.env.set_now(i64::MAX);
                assert_eq!(
                    close(&mut w),
                    Err(engine_error(EngineError::SharesHeld)),
                    "{expires_at}: the window ends past the last second"
                );
                let wallet = w.workers[1].pubkey();
                let other = w
                    .env
                    .create_token_account(&w.market.input_mint, &wallet, T22)?;
                let claim = SplitClaim {
                    recipients: w.wallets(),
                    weights: TERMS.weights.to_vec(),
                };
                let ix = w.claim_held_ix(&wallet, &delivery.announcement, &other, 1, claim);
                let signer = w.workers[1].insecure_clone();
                w.env.send(&signer, &[ix], &[])?;
                assert_eq!(w.env.balance(&other)?, SHARES[1], "{expires_at}: claimed");
                close(&mut w).map_err(|e| format!("{expires_at}: close: {e:?}"))?;
                assert_eq!(w.env.balance(&w.trader.input)?, KEPT, "{expires_at}: owner");
            }
        }
        assert!(
            !w.env.exists(&w.intent()),
            "{expires_at}: the escrow closes"
        );
    }
    Ok(())
}

#[test]
fn a_far_escrow_cancels_then_closes_returning_every_unit_and_lamport() -> TestResult {
    for expires_at in FAR {
        for now in [START_TS + 1, expires_at, i64::MAX] {
            let mut w = ReleaseWorld::expiring(&MINT, ReleasePath::Attested, TERMS, expires_at)?;
            let owner = w.trader.key.insecure_clone();
            let ix = w
                .env
                .cancel_ix(&owner.pubkey(), &w.market, 0, &w.trader.input);
            w.env.send(&owner, &[ix], &[])?;
            assert_eq!(
                w.env.balance(&w.trader.input)?,
                TERMS.funded,
                "{expires_at}: refunded"
            );
            let cranker = w.env.funded()?;
            w.env.set_now(now);
            let held = w
                .env
                .lamports(&w.intent())
                .checked_add(w.env.lamports(&w.vault()))
                .ok_or("lamports overflow")?;
            let before = w.env.lamports(&owner.pubkey());
            close_by(&mut w, &cranker)
                .map_err(|e| format!("{expires_at} at {now}: close: {e:?}"))?;
            assert_eq!(
                w.env.lamports(&owner.pubkey()),
                before.checked_add(held).ok_or("lamports overflow")?,
                "{expires_at} at {now}: rent and bounty return to the owner"
            );
            assert!(
                !w.env.exists(&w.intent()),
                "{expires_at} at {now}: the escrow closes"
            );
            assert_eq!(w.env.balance(&w.trader.input)?, TERMS.funded);
        }
    }
    Ok(())
}

#[test]
fn a_claim_on_a_far_escrow_runs_its_term_and_ends_at_the_expiry() -> TestResult {
    for expires_at in FAR {
        let mut w = claim_world(expires_at)?;
        let worker = w.funded()?;
        w.claim(&worker, HOUR)
            .map_err(|e| format!("{expires_at}: {e:?}"))?;
        assert_eq!(
            w.board()?.until,
            START_TS + 3_600,
            "{expires_at}: a full term"
        );

        let mut w = claim_world(expires_at)?;
        let worker = w.funded()?;
        let latest = expires_at - 3_600;
        w.set_now(latest + 1);
        assert_eq!(
            w.claim(&worker, HOUR).err(),
            Some(engine_error(EngineError::ClaimTerms)),
            "{expires_at}: a term past the expiry"
        );
        w.claim(&worker, HOUR - 1)
            .map_err(|e| format!("{expires_at}: {e:?}"))?;
        assert_eq!(
            w.board()?.until,
            expires_at,
            "{expires_at}: up to the expiry"
        );
    }
    Ok(())
}

#[test]
fn a_stand_by_on_a_far_escrow_holds_for_its_time_and_never_past_the_expiry() -> TestResult {
    for expires_at in FAR {
        for (now, held, until) in [
            (START_TS, 600, START_TS + 3_600),
            (expires_at - 100, 10, expires_at),
            (expires_at - 3_601, 10, expires_at - 1),
        ] {
            let mut w = claim_world(expires_at)?;
            w.set_now(now);
            let first = w.funded()?;
            let next = w.funded()?;
            w.claim(&first, held)
                .map_err(|e| format!("{expires_at}: {e:?}"))?;
            w.stand_by(&next, HOUR)?
                .map_err(|e| format!("{expires_at}: stand by: {e:?}"))?;
            w.drop_claim(&first)?
                .map_err(|e| format!("{expires_at}: drop: {e:?}"))?;
            let board = w.board()?;
            assert_eq!(
                (board.worker, board.until),
                (next.pubkey(), until),
                "{expires_at} at {now}"
            );
        }
    }
    Ok(())
}

#[test]
fn a_far_escrow_expires_at_its_second_and_its_announcement_waits_out_the_refute_window(
) -> TestResult {
    for expires_at in FAR {
        let mut w = ReleaseWorld::expiring(&MINT, ReleasePath::Attested, TERMS, expires_at)?;
        let worker = w.workers[0].insecure_clone();
        let stranger = w.env.funded()?;
        let intent = w.intent();
        let delivery = w.env.announce_for(&worker, &intent)?;
        let cranker = w.env.funded()?;
        let expire = w
            .env
            .expire_ix(&cranker.pubkey(), &w.owner(), &w.market, 0, &w.trader.input);
        w.env.set_now(expires_at - 1);
        assert_eq!(
            w.env
                .send(&cranker, std::slice::from_ref(&expire), &[])
                .map(|_| ()),
            Err(engine_error(EngineError::NotExpired)),
            "{expires_at}: a second early"
        );
        w.env.set_now(expires_at);
        w.env.send(&cranker, &[expire], &[])?;
        assert_eq!(
            w.env.balance(&w.trader.input)?,
            TERMS.funded,
            "{expires_at}: refunded"
        );

        let shut = |by: &Pubkey| {
            close_announcement_ix(by, &delivery.announcement, &intent, &worker.pubkey())
        };
        let by_stranger = shut(&stranger.pubkey());
        let early = w
            .env
            .send(&stranger, std::slice::from_ref(&by_stranger), &[])
            .map(|_| ());
        assert_eq!(
            early,
            Err(engine_error(EngineError::AnnouncementRetained)),
            "{expires_at}: kept for the refute window"
        );
        match expires_at.checked_add(REFUTE_WINDOW_SECS) {
            Some(edge) => {
                w.env.set_now(edge - 1);
                assert_eq!(
                    w.env
                        .send(&stranger, std::slice::from_ref(&by_stranger), &[])
                        .map(|_| ()),
                    Err(engine_error(EngineError::AnnouncementRetained)),
                    "{expires_at}: a second before the window ends"
                );
                w.env.set_now(edge);
                w.env.send(&stranger, &[by_stranger], &[])?;
            }
            None => {
                w.env.set_now(i64::MAX);
                assert_eq!(
                    w.env
                        .send(&stranger, std::slice::from_ref(&by_stranger), &[])
                        .map(|_| ()),
                    Err(engine_error(EngineError::AnnouncementRetained)),
                    "{expires_at}: the window ends past the last second"
                );
                w.env.send(&worker, &[shut(&worker.pubkey())], &[])?;
            }
        }
        assert!(
            !w.env.exists(&delivery.announcement),
            "{expires_at}: closed"
        );
        close_by(&mut w, &cranker).map_err(|e| format!("{expires_at}: close: {e:?}"))?;
        assert!(
            !w.env.exists(&w.intent()),
            "{expires_at}: the escrow closes"
        );
    }
    Ok(())
}
