use anchor_lang::prelude::Pubkey;
use intent_engine::errors::EngineError;
use intent_engine::state::{Announcement, PAUSE_FILL};
use litesvm::types::TransactionMetadata;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    book_pda, committee_batch_ix, ed25519_ix, engine_error_at, load, open_claims_ix,
    refutation_pda, refute_ix, reject_committee_digest, reject_envelope, settle_claims_ix,
    ClaimWorld, Fair, Reject, ReleasePath, TestResult, DOMAIN, FAIR_DAY, FAIR_EXPIRY, FAIR_HOLD,
    FAIR_KILL, FAIR_REVIEW, FAIR_STAKE, FAIR_TERMS, SALT,
};

const ROUTE: ReleasePath = ReleasePath::Attested;

fn ok(sent: Result<TransactionMetadata, TransactionError>) -> TestResult<TransactionMetadata> {
    sent.map_err(|e| format!("{e:?}").into())
}

fn state(w: &ClaimWorld, announcement: &Pubkey) -> TestResult<u8> {
    Ok(load::<Announcement>(&w.release.env.svm, announcement)?.state)
}

#[test]
fn a_judge_pass_relayed_during_review_pays_despite_a_cancel_attempt() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    ok(f.world.request_cancel())?;
    f.world.set_now(f.world.now() + FAIR_DAY);
    assert_eq!(
        f.cancel_now().err(),
        Some(engine_error_at(0, EngineError::ReviewPending))
    );
    let paid = f.world.release.env.balance(&f.world.release.atas[0])?;
    ok(f.release_holder()?)?;
    assert!(f.world.release.env.balance(&f.world.release.atas[0])? > paid);
    Ok(())
}

#[test]
fn silence_then_cancel_pays_the_holder() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    ok(f.world.request_cancel())?;
    f.world.set_now(f.review_until()?);
    let before = f.purse()?;
    ok(f.cancel_now())?;
    let after = f.purse()?;
    assert_eq!(after.holder, before.holder + FAIR_STAKE + FAIR_KILL);
    assert_eq!(after.owner, before.owner);
    Ok(())
}

#[test]
fn open_claims_after_an_announcement_is_refused() -> TestResult {
    let mut w = ClaimWorld::expiring(ROUTE, FAIR_TERMS, FAIR_EXPIRY)?;
    let worker = w.release.workers[0].insecure_clone();
    w.announce(&worker)?;
    assert_eq!(
        w.open_review(FAIR_REVIEW, FAIR_STAKE, FAIR_REVIEW, FAIR_KILL)
            .err(),
        Some(engine_error_at(0, EngineError::ClaimsAfterDelivery))
    );
    assert_eq!(
        w.open(FAIR_REVIEW, FAIR_STAKE, Some(&[worker.pubkey()]))
            .err(),
        Some(engine_error_at(0, EngineError::ClaimsAfterDelivery))
    );
    assert!(!w.exists(&w.board_key()));
    Ok(())
}

#[test]
fn claim_advance_settle_at_until_refused_while_reviewing() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    let until = f.board()?.until;
    let fresh = f.world.funded()?;
    f.world.set_now(until);
    assert_eq!(
        f.world.claim(&fresh, FAIR_HOLD).err(),
        Some(engine_error_at(0, EngineError::ClaimHeld))
    );
    assert_eq!(
        f.world.settle()?.err(),
        Some(engine_error_at(0, EngineError::ClaimHeld))
    );
    ok(f.world.stand_by(&fresh, FAIR_HOLD)?)?;
    assert_eq!(
        f.world.advance()?.err(),
        Some(engine_error_at(0, EngineError::ClaimHeld))
    );
    assert_eq!(f.board()?.held, FAIR_STAKE);
    Ok(())
}

#[test]
fn review_terms_are_fixed_at_open() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    let before = f.board()?;
    let owner = f.world.release.trader.key.insecure_clone();
    let again = open_claims_ix(&owner.pubkey(), &f.world.intent(), FAIR_HOLD, 0);
    assert!(f.world.send(&[again], &[&owner]).is_err());
    let after = f.board()?;
    assert_eq!(
        (
            after.review_secs,
            after.kill_fee,
            after.stake,
            after.review_until
        ),
        (
            before.review_secs,
            before.kill_fee,
            before.stake,
            before.review_until
        )
    );
    Ok(())
}

#[test]
fn dust_and_oversize_review_terms_are_refused() -> TestResult {
    let probe = ClaimWorld::expiring(ROUTE, FAIR_TERMS, FAIR_EXPIRY)?;
    let rent = probe.release.env.svm.minimum_balance_for_rent_exemption(0);
    let cases: [(u32, u64, u64, Option<EngineError>); 10] = [
        (3_599, 0, FAIR_STAKE, Some(EngineError::ReviewTerms)),
        (604_801, 0, FAIR_STAKE, Some(EngineError::ReviewTerms)),
        (0, rent, FAIR_STAKE, Some(EngineError::ReviewTerms)),
        (3_600, rent, 0, Some(EngineError::ReviewTerms)),
        (
            3_600,
            rent - 1,
            FAIR_STAKE,
            Some(EngineError::StakeBelowRent),
        ),
        (
            3_600,
            100_000_000_001,
            FAIR_STAKE,
            Some(EngineError::ReviewTerms),
        ),
        (3_600, rent, FAIR_STAKE, None),
        (604_800, 100_000_000_000, FAIR_STAKE, None),
        (3_600, 0, 0, None),
        (0, 0, FAIR_STAKE, None),
    ];
    for (secs, fee, stake, refusal) in cases {
        let mut w = ClaimWorld::expiring(ROUTE, FAIR_TERMS, FAIR_EXPIRY)?;
        let owner = w.owner();
        w.release
            .env
            .svm
            .airdrop(&owner, 200_000_000_000)
            .map_err(|e| format!("{e:?}"))?;
        let got = w.open_review(FAIR_HOLD, stake, secs, fee).err();
        assert_eq!(
            got,
            refusal.map(|e| engine_error_at(0, e)),
            "{secs} {fee} {stake}"
        );
        if refusal.is_none() {
            let board = w.board()?;
            assert_eq!((board.review_secs, board.kill_fee), (secs, fee));
            assert_eq!(w.lamports(&w.board_key()), w.board_rent() + fee);
        }
    }
    Ok(())
}

#[test]
fn cancel_refused_during_review_while_paused() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    let guardian = f.world.release.env.guardian.insecure_clone();
    let pause = f
        .world
        .release
        .env
        .raise_pause_ix(&guardian.pubkey(), PAUSE_FILL);
    ok(f.world.send(&[pause], &[&guardian]))?;
    ok(f.world.request_cancel())?;
    f.world.set_now(f.world.now() + FAIR_DAY);
    assert_eq!(
        f.cancel_now().err(),
        Some(engine_error_at(0, EngineError::ReviewPending))
    );
    Ok(())
}

#[test]
fn lapse_during_pause_pays() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    let guardian = f.world.release.env.guardian.insecure_clone();
    let pause = f
        .world
        .release
        .env
        .raise_pause_ix(&guardian.pubkey(), PAUSE_FILL);
    ok(f.world.send(&[pause], &[&guardian]))?;
    f.world.set_now(f.review_until()?);
    let before = f.purse()?;
    ok(f.world.settle()?)?;
    assert_eq!(f.purse()?.holder, before.holder + FAIR_STAKE + FAIR_KILL);
    Ok(())
}

#[test]
fn a_reject_returns_the_stake_and_records_rejected() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    let until = f.review_until()?;
    let before = f.purse()?;
    let d = f.delivery;
    ok(f.world.reject(&d)?)?;
    assert_eq!(f.purse()?.holder, before.holder + FAIR_STAKE);
    assert_eq!(state(&f.world, &d.announcement)?, 2);
    let board = f.board()?;
    assert_eq!(
        (board.worker, board.held, board.dropped_by, board.until),
        (Pubkey::default(), 0, f.holder.pubkey(), until)
    );
    let holder = f.holder.insecure_clone();
    assert_eq!(
        f.world.claim(&holder, FAIR_HOLD).err(),
        Some(engine_error_at(0, EngineError::ClaimCooldown))
    );
    Ok(())
}

#[test]
fn junk_rejected_in_time_earns_nothing() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    let before = f.purse()?;
    let d = f.delivery;
    ok(f.world.reject(&d)?)?;
    f.world.set_now(FAIR_EXPIRY);
    ok(f.world.settle()?)?;
    let after = f.purse()?;
    assert_eq!(after.holder, before.holder + FAIR_STAKE);
    assert_eq!(after.owner, before.owner + before.board - FAIR_STAKE);
    Ok(())
}

#[test]
fn committee_reject_uses_release_threshold() -> TestResult {
    let mut f = Fair::armed(ReleasePath::Committee)?;
    let before = f.purse()?;
    let d = f.delivery;
    ok(f.world.reject(&d)?)?;
    assert_eq!(f.purse()?.holder, before.holder + FAIR_STAKE);
    assert_eq!(state(&f.world, &d.announcement)?, 2);
    Ok(())
}

#[test]
fn committee_minority_cannot_reject() -> TestResult {
    let mut f = Fair::armed(ReleasePath::Committee)?;
    let intent = f.world.intent();
    let d = f.delivery;
    let panel = f.world.release.panel()?;
    let digest = reject_committee_digest(DOMAIN, &intent, &d.announcement, d.seq);
    let ix = Reject {
        committee: true,
        board: Some(f.world.board_key()),
        stake_to: Some(f.holder.pubkey()),
        mask: 0b001,
        ..Reject::new(intent, d.announcement, panel.address)
    }
    .ix();
    let sig = committee_batch_ix(&panel.keys, &panel.signers(&[0]), &digest)?;
    assert_eq!(
        f.world.send(&[sig, ix], &[]).err(),
        Some(engine_error_at(1, EngineError::CommitteeSigners))
    );
    assert_eq!(state(&f.world, &d.announcement)?, 0);
    Ok(())
}

fn key_reject(
    f: &Fair,
    signer: &Keypair,
    intent: &Pubkey,
    announcement: &Pubkey,
    seq: u64,
) -> Vec<solana_instruction::Instruction> {
    let message = reject_envelope(&signer.pubkey(), DOMAIN, intent, announcement, seq);
    let ix = Reject {
        board: Some(f.world.board_key()),
        stake_to: Some(f.holder.pubkey()),
        ..Reject::new(
            f.world.intent(),
            f.delivery.announcement,
            f.world.release.attestor.pubkey(),
        )
    }
    .ix();
    vec![ed25519_ix(signer, &message), ix]
}

#[test]
fn a_reject_needs_the_attestor_or_a_committee_threshold() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    let intent = f.world.intent();
    let d = f.delivery;
    let stranger = f.world.funded()?;
    let forged = key_reject(&f, &stranger, &intent, &d.announcement, d.seq);
    assert_eq!(
        f.world.send(&forged, &[]).err(),
        Some(engine_error_at(1, EngineError::SigPubkey))
    );
    let bare = forged.get(1).cloned().ok_or("no ix")?;
    assert_eq!(
        f.world.send(&[bare], &[]).err(),
        Some(engine_error_at(0, EngineError::SigMissing))
    );
    let judge = f.world.release.attestor.insecure_clone();
    let honest = key_reject(&f, &judge, &intent, &d.announcement, d.seq);
    ok(f.world.send(&honest, &[]))?;
    Ok(())
}

#[test]
fn a_reject_signature_does_not_fit_another_announcement_seq_or_escrow() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    let intent = f.world.intent();
    let d = f.delivery;
    let later = f.world.announce(&f.holder.insecure_clone())?;
    let judge = f.world.release.attestor.insecure_clone();
    let refused = [
        key_reject(&f, &judge, &intent, &later.announcement, d.seq),
        key_reject(&f, &judge, &intent, &d.announcement, d.seq + 1),
        key_reject(&f, &judge, &Pubkey::new_unique(), &d.announcement, d.seq),
    ];
    for ixs in refused {
        assert_eq!(
            f.world.send(&ixs, &[]).err(),
            Some(engine_error_at(1, EngineError::SigMessage))
        );
    }
    assert_eq!(state(&f.world, &d.announcement)?, 0);
    Ok(())
}

#[test]
fn a_rejected_announcement_cannot_be_released_or_rejected_again() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    let d = f.delivery;
    ok(f.world.reject(&d)?)?;
    assert_eq!(
        f.world.reject(&d)?.err(),
        Some(engine_error_at(1, EngineError::DeliveryNotPending))
    );
    f.world.delivery = Some(d);
    assert_eq!(
        f.world.release_to(ROUTE, None)?.err(),
        Some(engine_error_at(1, EngineError::AnnouncementPaid))
    );
    Ok(())
}

#[test]
fn a_paid_announcement_cannot_be_rejected() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    ok(f.release_holder()?)?;
    let d = f.delivery;
    let judge = f.world.release.attestor.insecure_clone();
    let intent = f.world.intent();
    let ixs = key_reject(&f, &judge, &intent, &d.announcement, d.seq);
    assert_eq!(
        f.world.send(&ixs, &[]).err(),
        Some(engine_error_at(1, EngineError::InvalidTransition))
    );
    Ok(())
}

#[test]
fn a_rejected_announcement_refutes_a_later_paid_copy() -> TestResult {
    let mut w = ClaimWorld::expiring(ROUTE, FAIR_TERMS, FAIR_EXPIRY)?;
    let copier = w.release.workers[0].insecure_clone();
    let author = w.funded()?;
    let earlier = w.announce(&author)?;
    ok(w.reject(&earlier)?)?;
    w.announce(&copier)?;
    ok(w.release_to(ROUTE, None)?)?;
    let paid = w.delivery.ok_or("no delivery")?;
    let owner = w.lamports(&w.owner());
    let ix = refute_ix(
        &author.pubkey(),
        &paid.announcement,
        &earlier.announcement,
        SALT,
        None,
    );
    ok(w.release.env.send(&author, &[ix], &[]))?;
    assert!(w.exists(&refutation_pda(&earlier.announcement)));
    assert_eq!(w.lamports(&w.owner()), owner);
    Ok(())
}

#[test]
fn a_second_wallet_cannot_announce_or_claim_during_review() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    let other = f.world.release.workers[1].insecure_clone();
    f.world.set_now(f.board()?.until + 1);
    assert!(f.world.announce(&other).is_err());
    assert_eq!(
        f.world.claim(&other, FAIR_HOLD).err(),
        Some(engine_error_at(0, EngineError::ClaimHeld))
    );
    Ok(())
}

#[test]
fn announce_after_cutoff_arms_no_review() -> TestResult {
    let (mut w, holder) = Fair::claimed(ROUTE, FAIR_REVIEW, FAIR_KILL)?;
    w.set_now(w.board()?.until);
    w.announce(&holder)?;
    let board = w.board()?;
    assert_eq!(
        (board.review_until, board.review_ann),
        (0, Pubkey::default())
    );
    Ok(())
}

#[test]
fn late_release_after_lapse_pays_full_price() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    f.world.set_now(f.review_until()?);
    ok(f.world.settle()?)?;
    let paid = f.world.release.env.balance(&f.world.release.atas[0])?;
    f.world.delivery = Some(f.delivery);
    ok(f.world.release_to(ROUTE, None)?)?;
    assert!(f.world.release.env.balance(&f.world.release.atas[0])? > paid);
    assert_eq!(f.purse()?.vault, 0);
    Ok(())
}

#[test]
fn release_of_a_later_announcement_resolves_the_review() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    let later = f.world.announce(&f.holder.insecure_clone())?;
    let before = f.purse()?;
    f.delivery = later;
    ok(f.release_holder()?)?;
    assert_eq!(f.purse()?.holder, before.holder + FAIR_STAKE);
    assert_eq!(f.board()?.review_until, 0);
    Ok(())
}

#[test]
fn split_without_the_holder_refused_during_review() -> TestResult {
    let mut w = ClaimWorld::expiring(ReleasePath::AttestedSplit, FAIR_TERMS, FAIR_EXPIRY)?;
    ok(w.open_review(FAIR_REVIEW, FAIR_STAKE, FAIR_REVIEW, FAIR_KILL))?;
    let holder = w.funded()?;
    ok(w.claim(&holder, FAIR_HOLD))?;
    w.announce(&holder)?;
    let recipient = w.release.workers[1].insecure_clone();
    assert!(w.announce(&recipient).is_err());
    assert!(w
        .release_to(ReleasePath::AttestedSplit, Some(&holder.pubkey()))?
        .is_err());
    assert_eq!(w.board()?.held, FAIR_STAKE);
    Ok(())
}

#[test]
fn refute_moves_no_lamports() -> TestResult {
    a_rejected_announcement_refutes_a_later_paid_copy()
}

#[test]
fn dust_on_board_and_book_changes_no_payout() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    let dust = 777_777;
    let board = f.world.board_key();
    let book = book_pda(&f.world.intent());
    f.world
        .release
        .env
        .svm
        .airdrop(&board, dust)
        .map_err(|e| format!("{e:?}"))?;
    f.world
        .release
        .env
        .svm
        .airdrop(&book, dust)
        .map_err(|e| format!("{e:?}"))?;
    f.world.set_now(f.review_until()?);
    let before = f.purse()?;
    ok(f.world.settle()?)?;
    assert_eq!(f.purse()?.holder, before.holder + FAIR_STAKE + FAIR_KILL);
    f.world.set_now(FAIR_EXPIRY);
    let owner = f.world.lamports(&f.world.owner());
    ok(f.world.settle()?)?;
    assert_eq!(
        f.world.lamports(&f.world.owner()),
        owner + f.world.board_rent() + dust
    );
    Ok(())
}

#[test]
fn settle_and_expire_pay_only_recorded_parties() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    f.world.set_now(f.review_until()?);
    let stranger = Pubkey::new_unique();
    let intent = f.world.intent();
    let owner = f.world.owner();
    let wrong_worker = settle_claims_ix(&intent, &owner, Some(&stranger));
    assert_eq!(
        f.world.send(&[wrong_worker], &[]).err(),
        Some(engine_error_at(0, EngineError::StakeAccountMismatch))
    );
    let wrong_owner = settle_claims_ix(&intent, &stranger, Some(&f.holder.pubkey()));
    assert_eq!(
        f.world.send(&[wrong_owner], &[]).err(),
        Some(engine_error_at(0, EngineError::StakeAccountMismatch))
    );
    let no_worker = settle_claims_ix(&intent, &owner, None);
    assert_eq!(
        f.world.send(&[no_worker], &[]).err(),
        Some(engine_error_at(0, EngineError::StakeAccountMismatch))
    );
    ok(f.world.settle()?)?;
    Ok(())
}

#[test]
fn settle_and_release_both_valid_at_review_until() -> TestResult {
    let mut first = Fair::armed(ROUTE)?;
    first.world.set_now(first.review_until()?);
    let before = first.purse()?;
    ok(first.world.settle()?)?;
    first.world.delivery = Some(first.delivery);
    ok(first.world.release_to(ROUTE, None)?)?;
    assert_eq!(
        first.purse()?.holder,
        before.holder + FAIR_STAKE + FAIR_KILL
    );
    let mut second = Fair::armed(ROUTE)?;
    second.world.set_now(second.review_until()?);
    let before = second.purse()?;
    ok(second.release_holder()?)?;
    assert_eq!(second.world.settle()?.err(), None);
    assert_eq!(second.purse()?.holder, before.holder + FAIR_STAKE);
    Ok(())
}

#[test]
fn a_full_claimant_list_reviews_lapses_and_closes() -> TestResult {
    let mut w = ClaimWorld::expiring(ROUTE, FAIR_TERMS, FAIR_EXPIRY)?;
    let holder = w.release.workers[0].insecure_clone();
    let mut workers = vec![holder.pubkey()];
    while workers.len() < intent_core::roster::MAX_CLAIMANTS {
        workers.push(Pubkey::new_unique());
    }
    let owner = w.release.trader.key.insecure_clone();
    let size = u8::try_from(workers.len())?;
    let (first, rest) = workers.split_at(16);
    let open = svm_tests::open_claims_listed_review_ix(
        &owner.pubkey(),
        &w.intent(),
        (FAIR_REVIEW, FAIR_STAKE),
        size,
        first,
        (FAIR_REVIEW, FAIR_KILL),
    );
    ok(w.send(&[open], &[&owner]))?;
    w.listed = true;
    let more = svm_tests::extend_claimants_ix(&owner.pubkey(), &w.intent(), rest);
    ok(w.send(&[more], &[&owner]))?;
    ok(w.claim(&holder, FAIR_HOLD))?;
    w.announce(&holder)?;
    let until = w.board()?.review_until;
    assert_ne!(until, 0);
    w.set_now(until);
    let before = w.lamports(&holder.pubkey());
    ok(w.settle()?)?;
    assert_eq!(
        w.lamports(&holder.pubkey()),
        before + FAIR_STAKE + FAIR_KILL
    );
    w.set_now(FAIR_EXPIRY);
    ok(w.settle()?)?;
    assert!(!w.exists(&w.board_key()) && !w.exists(&w.list_key()));
    Ok(())
}

#[test]
fn a_reject_naming_another_attestor_is_refused() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    let d = f.delivery;
    let impostor = f.world.funded()?;
    let message = reject_envelope(
        &impostor.pubkey(),
        DOMAIN,
        &f.world.intent(),
        &d.announcement,
        d.seq,
    );
    let ix = Reject {
        board: Some(f.world.board_key()),
        stake_to: Some(f.holder.pubkey()),
        ..Reject::new(f.world.intent(), d.announcement, impostor.pubkey())
    }
    .ix();
    assert_eq!(
        f.world
            .send(&[ed25519_ix(&impostor, &message), ix], &[])
            .err(),
        Some(engine_error_at(1, EngineError::AttestorMismatch))
    );
    assert_eq!(state(&f.world, &d.announcement)?, 0);
    Ok(())
}

#[test]
fn a_reject_against_a_board_another_program_owns_is_refused() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    let key = f.world.board_key();
    let mut account = f
        .world
        .release
        .env
        .svm
        .get_account(&key)
        .ok_or("no board")?;
    account.owner = anchor_spl::token::ID;
    f.world.release.env.svm.set_account(key, account)?;
    let d = f.delivery;
    assert_eq!(
        f.world.reject(&d)?.err(),
        Some(engine_error_at(1, EngineError::ClaimsMissing))
    );
    assert_eq!(state(&f.world, &d.announcement)?, 0);
    Ok(())
}

#[test]
fn a_reject_with_the_intent_in_place_of_the_announcement_is_refused() -> TestResult {
    let mut f = Fair::armed(ROUTE)?;
    let d = f.delivery;
    let mut ixs = f.world.reject_ixs(&d)?;
    let reject = ixs.get_mut(1).ok_or("no reject")?;
    let slot = reject.accounts.get_mut(2).ok_or("no announcement")?;
    slot.pubkey = f.world.intent();
    assert_eq!(
        f.world.send(&ixs, &[]).err(),
        Some(svm_tests::anchor_error_at(
            1,
            anchor_lang::error::ErrorCode::AccountDiscriminatorMismatch
        ))
    );
    Ok(())
}
