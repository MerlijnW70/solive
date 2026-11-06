use anchor_lang::prelude::Pubkey;
use intent_engine::errors::EngineError;
use intent_engine::events::{
    ClaimDropped, DeliveryRejected, DeliveryReleased, ReviewArmed, ReviewLapsed, StakeMoved,
};
use intent_engine::state::ClaimBoard;
use litesvm::types::TransactionMetadata;
use solana_keypair::Keypair;
use solana_signer::Signer;
use svm_tests::{
    engine_error_at, events, load, ClaimWorld, Fair, ReleasePath, TestResult, FAIR_DAY,
    FAIR_EXPIRY, FAIR_HOLD, FAIR_KILL, FAIR_REVIEW, FAIR_STAKE, FAIR_TERMS,
};

const ROUTE: ReleasePath = ReleasePath::Attested;

fn ok(
    sent: Result<TransactionMetadata, solana_transaction_error::TransactionError>,
) -> TestResult<TransactionMetadata> {
    sent.map_err(|e| format!("{e:?}").into())
}

fn lapsed(meta: &TransactionMetadata) -> Vec<ReviewLapsed> {
    events::<ReviewLapsed>(meta)
}

#[test]
fn an_armed_review_refuses_cancel_until_review_until() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    let until = f.review_until()?;
    ok(f.world.request_cancel())?;
    let cancel_at = f.world.now() + FAIR_DAY;
    for now in [cancel_at, until - 1] {
        f.world.set_now(now);
        assert_eq!(
            f.cancel_now().err(),
            Some(engine_error_at(0, EngineError::ReviewPending)),
            "{now}"
        );
        assert_eq!(
            f.world.expire().err(),
            Some(engine_error_at(0, EngineError::NotExpired))
        );
    }
    f.world.set_now(until);
    ok(f.cancel_now())?;
    Ok(())
}

#[test]
fn a_release_during_review_pays_the_holder() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    f.world.set_now(f.review_until()? - 1);
    let before = f.purse()?;
    ok(f.release_holder()?)?;
    let after = f.purse()?;
    assert_eq!(after.holder, before.holder + FAIR_STAKE);
    assert_eq!(after.board, before.board - FAIR_STAKE);
    let board = f.board()?;
    assert_eq!(
        (board.review_until, board.review_ann),
        (0, Pubkey::default())
    );
    assert_eq!(board.kill_fee, FAIR_KILL);
    Ok(())
}

#[test]
fn a_lapsed_review_pays_stake_and_kill_fee_through_settle_on_open_escrow() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    let until = f.review_until()?;
    f.world.set_now(until - 1);
    assert_eq!(
        f.world.settle()?.err(),
        Some(engine_error_at(0, EngineError::ClaimHeld))
    );
    f.world.set_now(until);
    let before = f.purse()?;
    let meta = ok(f.world.settle()?)?;
    let after = f.purse()?;
    assert_eq!(after.holder, before.holder + FAIR_STAKE + FAIR_KILL);
    assert_eq!(after.owner, before.owner);
    assert_eq!(after.vault, before.vault);
    let lapses = lapsed(&meta);
    assert_eq!(lapses.len(), 1);
    assert_eq!(
        lapses
            .first()
            .map(|l| (l.announcement, l.kill_fee, l.stake)),
        Some((f.delivery.announcement, FAIR_KILL, FAIR_STAKE))
    );
    assert_eq!(
        lapses.first().map(|l| l.attestor),
        Some(f.world.release.attestor.pubkey())
    );
    assert_eq!(events::<StakeMoved>(&meta).len(), 1);
    assert!(f.world.exists(&f.world.board_key()));
    let board = f.board()?;
    assert_eq!(
        (board.worker, board.held, board.kill_fee, board.review_until),
        (Pubkey::default(), 0, 0, 0)
    );
    let again = f.purse()?;
    assert_eq!(
        f.world.settle()?.err(),
        Some(engine_error_at(0, EngineError::InvalidTransition))
    );
    assert_eq!(f.purse()?.holder, again.holder);
    Ok(())
}

#[test]
fn a_lapsed_review_pays_stake_and_kill_fee_through_cancel() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    ok(f.world.request_cancel())?;
    f.world.set_now(f.review_until()?);
    let before = f.purse()?;
    let meta = ok(f.cancel_now())?;
    let after = f.purse()?;
    assert_eq!(after.holder, before.holder + FAIR_STAKE + FAIR_KILL);
    assert_eq!(lapsed(&meta).len(), 1);
    assert_eq!(f.board()?.kill_fee, 0);
    let wound = f.purse()?;
    f.world.wind_up()?;
    assert_eq!(f.world.lamports(&f.holder.pubkey()), wound.holder);
    Ok(())
}

#[test]
fn a_lapsed_review_pays_stake_and_kill_fee_through_settle_after_expiry() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    f.world.set_now(FAIR_EXPIRY);
    ok(f.world.expire())?;
    let before = f.purse()?;
    let rent = f.world.board_rent();
    let meta = ok(f.world.settle()?)?;
    assert_eq!(lapsed(&meta).len(), 1);
    assert_eq!(
        f.world.lamports(&f.holder.pubkey()),
        before.holder + FAIR_STAKE + FAIR_KILL
    );
    assert_eq!(f.world.lamports(&f.world.owner()), before.owner + rent);
    assert!(!f.world.exists(&f.world.board_key()));
    Ok(())
}

fn holder_stake_still_on_board(f: &Fair, owner: u64) -> TestResult {
    let board = f.board()?;
    assert_eq!((board.worker, board.held), (f.holder.pubkey(), FAIR_STAKE));
    assert_eq!(f.world.lamports(&f.world.owner()), owner);
    Ok(())
}

#[test]
fn no_route_moves_a_reviewing_holders_stake_to_the_owner() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    let raw_until = f.board()?.until;
    let until = f.review_until()?;
    let other = f.world.funded()?;
    let line = f.world.funded()?;
    ok(f.world.stand_by(&line, FAIR_HOLD)?)?;
    ok(f.world.request_cancel())?;
    let book = svm_tests::book_pda(&f.world.intent());
    let cancel_at =
        load::<intent_engine::state::DeliveryBook>(&f.world.release.env.svm, &book)?.cancel_at;
    assert!(cancel_at < until);
    for now in [raw_until, raw_until + 1, cancel_at, until - 1] {
        f.world.set_now(now);
        let owner = f.world.lamports(&f.world.owner());
        assert_eq!(
            f.world.claim(&other, FAIR_HOLD).err(),
            Some(engine_error_at(0, EngineError::LineWaiting)),
            "{now}"
        );
        assert_eq!(
            f.world.advance()?.err(),
            Some(engine_error_at(0, EngineError::ClaimHeld)),
            "{now}"
        );
        assert_eq!(
            f.world.settle()?.err(),
            Some(engine_error_at(0, EngineError::ClaimHeld)),
            "{now}"
        );
        let refusal = if now >= cancel_at {
            EngineError::ReviewPending
        } else {
            EngineError::CancelNoticeRunning
        };
        assert_eq!(
            f.cancel_now().err(),
            Some(engine_error_at(0, refusal)),
            "{now}"
        );
        let other_ata = f.world.release.atas[1];
        let delivery = f.delivery;
        let sent = f.world.release.release_to(ROUTE, &delivery, &other_ata)?;
        assert!(sent.is_err(), "{now}");
        holder_stake_still_on_board(&f, owner)?;
    }
    Ok(())
}

#[test]
fn a_fresh_claim_at_the_raw_deadline_is_refused_while_reviewing() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    let other = f.world.funded()?;
    f.world.set_now(f.board()?.until);
    let owner = f.world.lamports(&f.world.owner());
    assert_eq!(
        f.world.claim(&other, FAIR_HOLD).err(),
        Some(engine_error_at(0, EngineError::ClaimHeld))
    );
    holder_stake_still_on_board(&f, owner)
}

#[test]
fn no_announcement_moves_vault_tokens() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    let vault = f.purse()?.vault;
    assert_eq!(vault, FAIR_TERMS.escrow);
    let again = f.world.announce(&f.holder.insecure_clone())?;
    assert_eq!(f.purse()?.vault, vault);
    ok(f.world.reject(&again)?)?;
    assert_eq!(f.purse()?.vault, vault);
    f.world.set_now(f.review_until()?);
    ok(f.world.settle()?)?;
    assert_eq!(f.purse()?.vault, vault);
    Ok(())
}

#[test]
fn kill_fee_pays_once_per_board() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    let until = f.review_until()?;
    f.world.set_now(until);
    ok(f.world.settle()?)?;
    let second = f.world.funded()?;
    ok(f.world.claim(&second, FAIR_HOLD))?;
    let d = f.world.announce(&second)?;
    let board = f.board()?;
    assert_eq!(board.review_ann, d.announcement);
    assert_eq!(board.kill_fee, 0);
    f.world.set_now(board.review_until);
    let before = f.world.lamports(&second.pubkey());
    let meta = ok(f.world.settle()?)?;
    assert_eq!(f.world.lamports(&second.pubkey()), before + FAIR_STAKE);
    assert_eq!(lapsed(&meta).first().map(|l| l.kill_fee), Some(0));
    Ok(())
}

#[test]
fn a_reject_before_review_until_pays_no_kill_fee() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    f.world.set_now(f.review_until()? - 1);
    let before = f.purse()?;
    let delivery = f.delivery;
    let meta = ok(f.world.reject(&delivery)?)?;
    let after = f.purse()?;
    assert_eq!(after.holder, before.holder + FAIR_STAKE);
    assert_eq!(after.board, before.board - FAIR_STAKE);
    assert_eq!(f.board()?.kill_fee, FAIR_KILL);
    assert!(lapsed(&meta).is_empty());
    f.world.set_now(FAIR_EXPIRY);
    ok(f.world.expire())?;
    let owner = f.world.lamports(&f.world.owner());
    let rent = f.world.board_rent();
    ok(f.world.settle()?)?;
    assert_eq!(f.world.lamports(&f.world.owner()), owner + rent + FAIR_KILL);
    Ok(())
}

#[test]
fn a_release_before_review_until_pays_no_kill_fee() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    let before = f.purse()?;
    let meta = ok(f.release_holder()?)?;
    assert!(lapsed(&meta).is_empty());
    assert_eq!(f.purse()?.holder, before.holder + FAIR_STAKE);
    assert_eq!(f.board()?.kill_fee, FAIR_KILL);
    Ok(())
}

#[test]
fn an_unused_kill_fee_returns_to_the_owner_at_board_close() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    ok(f.release_holder()?)?;
    let owner = f.world.lamports(&f.world.owner());
    let board = f.world.lamports(&f.world.board_key());
    assert_eq!(board, f.world.board_rent() + FAIR_KILL);
    let meta = ok(f.world.settle()?)?;
    assert!(lapsed(&meta).is_empty());
    assert_eq!(f.world.lamports(&f.world.owner()), owner + board);
    Ok(())
}

fn served_late(announce_at: i64) -> TestResult<(ClaimWorld, Keypair, svm_tests::Delivery)> {
    let mut w = ClaimWorld::expiring(ROUTE, FAIR_TERMS, FAIR_EXPIRY)?;
    ok(w.open_review(FAIR_REVIEW, FAIR_STAKE, FAIR_REVIEW, FAIR_KILL))?;
    let holder = w.release.workers[1].insecure_clone();
    let late = w.release.workers[0].insecure_clone();
    let review = i64::from(FAIR_REVIEW);
    let hold = i64::from(FAIR_HOLD);
    w.set_now(FAIR_EXPIRY.saturating_sub(review).saturating_sub(hold));
    ok(w.claim(&holder, FAIR_HOLD))?;
    ok(w.stand_by(&late, FAIR_HOLD)?)?;
    w.set_now(FAIR_EXPIRY.saturating_sub(review).saturating_sub(1));
    ok(w.drop_claim(&holder)?)?;
    assert_eq!(w.board()?.worker, late.pubkey());
    assert!(w.board()?.until > FAIR_EXPIRY.saturating_sub(review));
    w.set_now(announce_at);
    let d = w.announce(&late)?;
    Ok((w, late, d))
}

#[test]
fn a_review_never_arms_with_less_than_review_secs_left() -> TestResult {
    let review = i64::from(FAIR_REVIEW);
    let (w, _, edge) = served_late(FAIR_EXPIRY - review)?;
    let board = w.board()?;
    assert_eq!(
        (board.review_ann, board.review_until),
        (edge.announcement, FAIR_EXPIRY)
    );
    let (w, late, unprotected) = served_late(FAIR_EXPIRY - review + 1)?;
    let board = w.board()?;
    assert_eq!(
        (board.review_ann, board.review_until),
        (Pubkey::default(), 0)
    );
    assert_eq!(board.worker, late.pubkey());
    assert_ne!(unprotected.announcement, Pubkey::default());
    Ok(())
}

#[test]
fn claim_job_refuses_secs_that_leave_no_review() -> TestResult {
    let mut w = ClaimWorld::expiring(ROUTE, FAIR_TERMS, FAIR_EXPIRY)?;
    ok(w.open_review(FAIR_REVIEW, FAIR_STAKE, FAIR_REVIEW, FAIR_KILL))?;
    let holder = w.release.workers[0].insecure_clone();
    let room = FAIR_EXPIRY - i64::from(FAIR_REVIEW) - i64::from(FAIR_HOLD);
    w.set_now(room + 1);
    assert_eq!(
        w.claim(&holder, FAIR_HOLD).err(),
        Some(engine_error_at(0, EngineError::ReviewPastExpiry))
    );
    w.set_now(room);
    ok(w.claim(&holder, FAIR_HOLD))?;
    Ok(())
}

#[test]
fn later_announcements_never_move_review_until_or_cancel_at() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    let until = f.review_until()?;
    f.world.set_now(f.world.now() + 100);
    let again = f.world.announce(&f.holder.insecure_clone())?;
    let board = f.board()?;
    assert_eq!(
        (board.review_until, board.review_ann),
        (until, f.delivery.announcement)
    );
    assert_ne!(again.announcement, f.delivery.announcement);
    ok(f.world.request_cancel())?;
    let book = svm_tests::book_pda(&f.world.intent());
    let at = load::<intent_engine::state::DeliveryBook>(&f.world.release.env.svm, &book)?.cancel_at;
    f.world.set_now(f.world.now() + 100);
    f.world.announce(&f.holder.insecure_clone())?;
    assert_eq!(
        load::<intent_engine::state::DeliveryBook>(&f.world.release.env.svm, &book)?.cancel_at,
        at
    );
    assert_eq!(
        f.world.request_cancel().err(),
        Some(engine_error_at(0, EngineError::CancelAlreadyRequested))
    );
    assert_eq!(f.review_until()?, until);
    Ok(())
}

#[derive(Clone, Copy, Debug)]
enum Outcome {
    Released,
    Rejected,
    Dropped,
    Lapsed,
}

fn outcomes(meta: &TransactionMetadata, announcement: Pubkey) -> Vec<Outcome> {
    let mut out = Vec::new();
    out.extend(
        events::<DeliveryReleased>(meta)
            .iter()
            .filter(|e| e.announcement == announcement)
            .map(|_| Outcome::Released),
    );
    out.extend(
        events::<DeliveryRejected>(meta)
            .iter()
            .filter(|e| e.announcement == announcement)
            .map(|_| Outcome::Rejected),
    );
    out.extend(
        events::<ClaimDropped>(meta)
            .iter()
            .filter(|e| e.announcement == announcement)
            .map(|_| Outcome::Dropped),
    );
    out.extend(
        events::<ReviewLapsed>(meta)
            .iter()
            .filter(|e| e.announcement == announcement)
            .map(|_| Outcome::Lapsed),
    );
    out
}

#[test]
fn every_armed_review_ends_in_exactly_one_outcome_event() -> TestResult {
    for branch in [
        Outcome::Released,
        Outcome::Rejected,
        Outcome::Dropped,
        Outcome::Lapsed,
    ] {
        let mut f = Fair::armed(ROUTE)?;
        let ann = f.delivery.announcement;
        let meta = match branch {
            Outcome::Released => ok(f.release_holder()?)?,
            Outcome::Rejected => {
                let d = f.delivery;
                ok(f.world.reject(&d)?)?
            }
            Outcome::Dropped => {
                let holder = f.holder.insecure_clone();
                ok(f.world.drop_claim(&holder)?)?
            }
            Outcome::Lapsed => {
                f.world.set_now(f.review_until()?);
                ok(f.world.settle()?)?
            }
        };
        let seen = outcomes(&meta, ann);
        assert_eq!(seen.len(), 1, "{branch:?} {seen:?}");
        assert_eq!(f.board()?.review_until, 0, "{branch:?}");
        f.world.set_now(FAIR_EXPIRY);
        let meta = ok(f.world.settle()?)?;
        assert!(outcomes(&meta, ann).is_empty(), "{branch:?}");
    }
    Ok(())
}

#[test]
fn a_reject_at_review_until_is_refused() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    f.world.set_now(f.review_until()?);
    let d = f.delivery;
    assert_eq!(
        f.world.reject(&d)?.err(),
        Some(engine_error_at(1, EngineError::ReviewLapsed))
    );
    f.world.set_now(f.review_until()? - 1);
    ok(f.world.reject(&d)?)?;
    Ok(())
}

#[test]
fn expire_runs_at_expires_at_with_an_armed_review_and_a_pending_notice() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    ok(f.world.request_cancel())?;
    f.world.set_now(FAIR_EXPIRY - 1);
    assert_eq!(
        f.world.expire().err(),
        Some(engine_error_at(0, EngineError::NotExpired))
    );
    f.world.set_now(FAIR_EXPIRY);
    ok(f.world.expire())?;
    assert_eq!(f.purse()?.vault, 0);
    Ok(())
}

#[test]
fn no_lock_outlives_expiry() -> TestResult {
    for past in [0, 1, FAIR_DAY, 400 * FAIR_DAY] {
        let mut f = Fair::armed(ROUTE)?;
        assert!(f.review_until()? <= FAIR_EXPIRY);
        f.world.set_now(FAIR_EXPIRY + past);
        ok(f.world.expire())?;
        let before = f.world.lamports(&f.holder.pubkey());
        ok(f.world.settle()?)?;
        assert_eq!(
            f.world.lamports(&f.holder.pubkey()),
            before + FAIR_STAKE + FAIR_KILL
        );
        assert!(!f.world.exists(&f.world.board_key()));
    }
    Ok(())
}

#[test]
fn settle_after_end_always_closes_the_board() -> TestResult {
    let mut w = ClaimWorld::expiring(ROUTE, FAIR_TERMS, FAIR_EXPIRY)?;
    let rent = w.release.env.svm.minimum_balance_for_rent_exemption(0);
    ok(w.open_review(FAIR_REVIEW, rent, FAIR_REVIEW, rent))?;
    let holder = Keypair::new();
    w.release
        .env
        .svm
        .airdrop(&holder.pubkey(), 1_000_000_000)
        .map_err(|e| format!("{e:?}"))?;
    ok(w.claim(&holder, FAIR_HOLD))?;
    w.announce(&holder)?;
    let left = w.lamports(&holder.pubkey());
    let sink = Pubkey::new_unique();
    let ix = solana_system_interface::instruction::transfer(&holder.pubkey(), &sink, left);
    let payer = w.payer.insecure_clone();
    w.release
        .env
        .send(&payer, &[ix], &[&holder])
        .map_err(|e| format!("{e:?}"))?;
    assert_eq!(w.lamports(&holder.pubkey()), 0);
    w.set_now(FAIR_EXPIRY);
    ok(w.expire())?;
    ok(w.settle()?)?;
    assert_eq!(w.lamports(&holder.pubkey()), rent + rent);
    assert!(!w.exists(&w.board_key()));
    Ok(())
}

#[test]
fn cancel_succeeds_at_max_of_cancel_at_and_review_until() -> TestResult {
    for review in [3_600u32, 86_400, FAIR_REVIEW] {
        let mut f = Fair::armed_with(ROUTE, review, FAIR_KILL)?;
        ok(f.world.request_cancel())?;
        let ready = (f.world.now() + FAIR_DAY).max(f.review_until()?);
        f.world.set_now(ready - 1);
        assert!(f.cancel_now().is_err(), "{review}");
        f.world.set_now(ready);
        ok(f.cancel_now())?;
    }
    Ok(())
}

#[test]
fn the_review_armed_event_names_the_announcement_and_terms() -> TestResult {
    let (mut w, holder) = Fair::claimed(ROUTE, FAIR_REVIEW, FAIR_KILL)?;
    let intent = w.intent();
    let attestor = w.release.attestor.pubkey();
    let (blob, _) = w.release.env.delivery_blob(&intent, &attestor)?;
    let a = svm_tests::Announce {
        board: Some(w.board_key()),
        ..svm_tests::Announce::new(holder.pubkey(), intent, attestor, blob)
    };
    let meta = ok(w.release.env.send(&holder, &[a.ix()], &[]))?;
    let armed = events::<ReviewArmed>(&meta);
    let until = w.now() + i64::from(FAIR_REVIEW);
    assert_eq!(armed.len(), 1);
    let first = armed.first().ok_or("no event")?;
    assert_eq!(
        (
            first.intent,
            first.announcement,
            first.worker,
            first.attestor,
            first.review_until,
            first.kill_fee
        ),
        (
            intent,
            a.address(),
            holder.pubkey(),
            attestor,
            until,
            FAIR_KILL
        )
    );
    let board: ClaimBoard = w.board()?;
    assert_eq!((board.review_ann, board.review_until), (a.address(), until));
    Ok(())
}
