use intent_engine::errors::EngineError;
use intent_engine::state::{Announcement, ClaimBoard, CLAIMS_VERSION};
use intent_engine::versions::{migration_of, V2_BOARD_SPACE, V2_BOARD_VERSION};
use solana_signer::Signer;
use svm_tests::{
    engine_error, load, migrate_ix, settle_claims_listed_ix, ClaimWorld, Fair, ReleasePath,
    TestResult, FAIR_DAY, FAIR_STAKE,
};

fn board_rent(w: &ClaimWorld, space: usize) -> u64 {
    w.release.env.svm.minimum_balance_for_rent_exemption(space)
}

fn to_v2(w: &mut ClaimWorld) -> TestResult {
    let key = w.board_key();
    let mut account = w.release.env.svm.get_account(&key).ok_or("no board")?;
    account.data.truncate(V2_BOARD_SPACE);
    let at = 8usize.saturating_add(core::mem::offset_of!(ClaimBoard, version));
    *account.data.get_mut(at).ok_or("short")? = V2_BOARD_VERSION;
    account.lamports = board_rent(w, V2_BOARD_SPACE).saturating_add(FAIR_STAKE);
    w.release.env.svm.set_account(key, account)?;
    Ok(())
}

#[test]
fn a_held_version_two_board_cancels_to_its_worker_and_then_settles_closed() -> TestResult {
    let (mut w, holder) = Fair::claimed(ReleasePath::Attested, 0, 0)?;
    to_v2(&mut w)?;
    let before = w.lamports(&holder.pubkey());
    w.cancel(Some(&holder.pubkey()))
        .map_err(|e| format!("cancel: {e:?}"))?;
    assert_eq!(
        w.lamports(&holder.pubkey()),
        before.saturating_add(FAIR_STAKE)
    );
    let owner = w.lamports(&w.owner());
    let rent = board_rent(&w, V2_BOARD_SPACE);
    let ix = settle_claims_listed_ix(&w.intent(), &w.owner(), None, None);
    w.send(&[ix], &[]).map_err(|e| format!("settle: {e:?}"))?;
    assert!(!w.exists(&w.board_key()));
    assert_eq!(w.lamports(&w.owner()), owner.saturating_add(rent));
    Ok(())
}

#[test]
fn a_version_two_board_refuses_announce_lets_a_reject_read_it_and_cancels_after_notice(
) -> TestResult {
    let (mut w, holder) = Fair::claimed(ReleasePath::Attested, 0, 0)?;
    let d = w.announce(&holder)?;
    to_v2(&mut w)?;
    let other = w.funded()?;
    assert!(w.announce(&other).is_err());
    w.reject(&d)?.map_err(|e| format!("reject: {e:?}"))?;
    let stored: Announcement = load(&w.release.env.svm, &d.announcement)?;
    assert_eq!(stored.state, 2);
    let account = w
        .release
        .env
        .svm
        .get_account(&w.board_key())
        .ok_or("no board")?;
    assert_eq!(account.data.len(), V2_BOARD_SPACE);
    w.request_cancel().map_err(|e| format!("request: {e:?}"))?;
    w.set_now(w.now().saturating_add(FAIR_DAY));
    let owner = w.lamports(&w.owner());
    let to = w.owner();
    w.cancel(Some(&to)).map_err(|e| format!("cancel: {e:?}"))?;
    assert_eq!(w.lamports(&w.owner()), owner.saturating_add(FAIR_STAKE));
    Ok(())
}

#[test]
fn a_version_two_board_migrates_to_version_three_with_no_review() -> TestResult {
    let (mut w, holder) = Fair::claimed(ReleasePath::Attested, 0, 0)?;
    to_v2(&mut w)?;
    let payer = w.payer.insecure_clone();
    let key = w.board_key();
    let ix = migrate_ix(&payer.pubkey(), &key, None);
    w.release
        .env
        .send(&payer, &[ix], &[])
        .map_err(|e| format!("migrate: {e:?}"))?;
    let b = w.board()?;
    assert_eq!(b.version, CLAIMS_VERSION);
    assert_eq!((b.review_until, b.kill_fee, b.review_secs), (0, 0, 0));
    assert_eq!((b.worker, b.held), (holder.pubkey(), FAIR_STAKE));
    assert_eq!(w.lamports(&key), w.board_rent().saturating_add(FAIR_STAKE));
    Ok(())
}

#[test]
fn a_current_size_board_with_an_older_version_byte_is_no_layout_and_does_not_migrate() -> TestResult
{
    let (mut w, _) = Fair::claimed(ReleasePath::Attested, 0, 0)?;
    let key = w.board_key();
    let mut account = w.release.env.svm.get_account(&key).ok_or("no board")?;
    let at = 8usize.saturating_add(core::mem::offset_of!(ClaimBoard, version));
    for version in [1u8, V2_BOARD_VERSION] {
        *account.data.get_mut(at).ok_or("short")? = version;
        assert!(migration_of(&account.data).is_none(), "{version}");
    }
    w.release.env.svm.set_account(key, account)?;
    let payer = w.payer.insecure_clone();
    let ix = migrate_ix(&payer.pubkey(), &key, None);
    assert_eq!(
        w.release.env.send(&payer, &[ix], &[]).err(),
        Some(engine_error(EngineError::UnknownLayout))
    );
    Ok(())
}
