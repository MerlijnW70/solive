use anchor_lang::prelude::Pubkey;
use intent_engine::errors::EngineError;
use intent_engine::events::{JobClaimed, LineLeft};
use litesvm::types::TransactionMetadata;
use solana_keypair::Keypair;
use solana_signer::Signer;
use svm_tests::{
    advance_ix, advance_line_ix, claim_job_ix, drop_claim_ix, drop_claim_line_ix, engine_error_at,
    events, stand_by_ix, standby_pda, ClaimWorld, ReleasePath, ReleaseTerms, TestResult, START_TS,
};

const STAKE: u64 = 50_000_000;
const HOUR: u32 = 3_600;
const HOLD: u32 = 600;
const TERMS: ReleaseTerms = ReleaseTerms {
    funded: 1_000_000,
    escrow: 100_000,
    judge_fee: 0,
    spec: [0x6d; 32],
    weights: [6_000, 4_000],
    partner_bps: 0,
};

fn opened() -> TestResult<ClaimWorld> {
    let mut w = ClaimWorld::new(ReleasePath::Attested, TERMS)?;
    w.open(HOUR, STAKE, None).map_err(|e| format!("{e:?}"))?;
    Ok(w)
}

fn at(secs: i64) -> TestResult<i64> {
    Ok(START_TS.checked_add(secs).ok_or("overflow")?)
}

fn left(meta: &TransactionMetadata) -> Vec<(Pubkey, u32, u64)> {
    events::<LineLeft>(meta)
        .into_iter()
        .map(|e| (e.worker, e.seq, e.refunded))
        .collect()
}

fn claimed(meta: &TransactionMetadata) -> Vec<(Pubkey, i64, u64)> {
    events::<JobClaimed>(meta)
        .into_iter()
        .map(|e| (e.worker, e.until, e.stake))
        .collect()
}

fn stand(w: &mut ClaimWorld, who: &Keypair, secs: u32) -> TestResult {
    w.stand_by(who, secs)?
        .map_err(|e| format!("stand by: {e:?}"))?;
    Ok(())
}

fn sum(parts: &[u64]) -> TestResult<u64> {
    parts
        .iter()
        .try_fold(0u64, |total, part| total.checked_add(*part))
        .ok_or_else(|| "overflow".into())
}

#[test]
fn a_holder_cannot_drop_and_take_the_claim_again_through_its_own_entry() -> TestResult {
    let mut w = opened()?;
    let holder = w.funded()?;
    let rival = w.funded()?;
    let intent = w.intent();
    let owner = w.owner();
    w.claim(&holder, HOLD).map_err(|e| format!("{e:?}"))?;
    let renew = [
        drop_claim_ix(&holder.pubkey(), &intent),
        claim_job_ix(&holder.pubkey(), &intent, &owner, HOUR),
    ];
    assert_eq!(
        w.send(&renew, &[&holder]).err(),
        Some(engine_error_at(1, EngineError::ClaimCooldown)),
        "the rule: a worker that drops cannot claim again before its term ends"
    );
    w.set_now(at(599)?);
    let before = w.lamports(&holder.pubkey());
    let board_before = w.lamports(&w.board_key());
    let through_line = [
        stand_by_ix(&holder.pubkey(), &intent, 0, 3_000),
        drop_claim_line_ix(
            &holder.pubkey(),
            &intent,
            &[standby_pda(&intent, 0)],
            Some(&holder.pubkey()),
        ),
    ];
    assert_eq!(
        w.send(&through_line, &[&holder]).err(),
        Some(engine_error_at(0, EngineError::HolderStandsBy)),
        "the holder cannot join its own line to renew its term"
    );
    let board = w.board()?;
    assert_eq!(
        (
            board.worker,
            board.held,
            board.until,
            board.dropped_by,
            board.tail
        ),
        (holder.pubkey(), STAKE, at(600)?, Pubkey::default(), 0),
        "the holder keeps only the term it claimed"
    );
    assert_eq!(w.lamports(&holder.pubkey()), before);
    assert_eq!(w.lamports(&w.board_key()), board_before);
    assert!(!w.exists(&standby_pda(&intent, 0)));
    assert_eq!(
        w.claim(&rival, 60).err(),
        Some(engine_error_at(0, EngineError::ClaimHeld))
    );
    w.set_now(at(600)?);
    w.claim(&rival, 60).map_err(|e| format!("{e:?}"))?;
    Ok(())
}

#[test]
fn the_holder_is_refused_at_stand_by_and_everyone_else_joins() -> TestResult {
    let mut w = opened()?;
    let holder = w.funded()?;
    let waiter = w.funded()?;
    w.claim(&holder, HOLD).map_err(|e| format!("{e:?}"))?;
    let before = w.lamports(&holder.pubkey());
    assert_eq!(
        w.stand_by(&holder, HOLD)?.err(),
        Some(engine_error_at(0, EngineError::HolderStandsBy))
    );
    assert_eq!(w.lamports(&holder.pubkey()), before);
    assert_eq!(w.board()?.tail, 0);
    stand(&mut w, &waiter, HOLD)?;
    assert_eq!(
        w.stand_by(&holder, HOLD)?.err(),
        Some(engine_error_at(0, EngineError::HolderStandsBy)),
        "a waiting line does not let the holder in either"
    );
    let board = w.board()?;
    assert_eq!(
        (board.worker, board.head, board.tail),
        (holder.pubkey(), 0, 1)
    );
    w.check_holdings(STAKE)
}

#[test]
fn a_droppers_own_entry_is_closed_to_it_and_the_next_waiter_holds_for_its_time() -> TestResult {
    let mut w = opened()?;
    let first = w.funded()?;
    let dropper = w.funded()?;
    let next = w.funded()?;
    w.claim(&first, HOLD).map_err(|e| format!("{e:?}"))?;
    stand(&mut w, &dropper, 300)?;
    stand(&mut w, &dropper, 900)?;
    stand(&mut w, &next, 1_200)?;
    w.drop_with(&first, &[0], Some(&dropper.pubkey()))
        .map_err(|e| format!("{e:?}"))?;
    assert_eq!(
        (w.board()?.worker, w.board()?.until),
        (dropper.pubkey(), at(300)?)
    );
    w.set_now(at(100)?);
    assert_eq!(
        w.drop_with(&dropper, &[1, 2], Some(&dropper.pubkey()))
            .err(),
        Some(engine_error_at(0, EngineError::StakeAccountMismatch)),
        "the dropper's entry is not served to it"
    );
    let rent = w.entry_rent();
    let dropper_before = w.lamports(&dropper.pubkey());
    let next_before = w.lamports(&next.pubkey());
    let board_before = w.lamports(&w.board_key());
    let meta = w
        .drop_with(&dropper, &[1, 2], Some(&next.pubkey()))
        .map_err(|e| format!("{e:?}"))?;
    assert_eq!(
        w.lamports(&dropper.pubkey()),
        sum(&[dropper_before, STAKE, STAKE, rent])?,
        "the dropper gets its claim's stake and its entry's stake and rent"
    );
    assert_eq!(w.lamports(&next.pubkey()), sum(&[next_before, rent])?);
    assert_eq!(
        w.lamports(&w.board_key()),
        board_before,
        "the dropper's stake leaves and the waiter's stake arrives"
    );
    assert_eq!(left(&meta), [(dropper.pubkey(), 1, STAKE + rent)]);
    assert_eq!(claimed(&meta), [(next.pubkey(), at(1_300)?, STAKE)]);
    let board = w.board()?;
    assert_eq!(
        (
            board.worker,
            board.until,
            board.held,
            board.head,
            board.tail,
            board.dropped_by
        ),
        (next.pubkey(), at(1_300)?, STAKE, 3, 3, Pubkey::default())
    );
    assert!(!w.exists(&w.entry_key(1)) && !w.exists(&w.entry_key(2)));
    w.check_holdings(STAKE)?;
    w.wind_up()
}

fn dropped_with_own_entry_behind() -> TestResult<(ClaimWorld, Keypair, Keypair)> {
    let mut w = opened()?;
    let first = w.funded()?;
    let dropper = w.funded()?;
    let gone = w.funded()?;
    let next = w.funded()?;
    w.claim(&first, HOLD).map_err(|e| format!("{e:?}"))?;
    stand(&mut w, &dropper, 60)?;
    stand(&mut w, &gone, 600)?;
    stand(&mut w, &dropper, 900)?;
    stand(&mut w, &next, 1_200)?;
    w.leave(&gone, 1, &gone.pubkey())
        .map_err(|e| format!("{e:?}"))?;
    w.drop_with(&first, &[0], Some(&dropper.pubkey()))
        .map_err(|e| format!("{e:?}"))?;
    w.set_now(at(10)?);
    let meta = w
        .drop_with(&dropper, &[1], None)
        .map_err(|e| format!("{e:?}"))?;
    assert!(claimed(&meta).is_empty() && left(&meta).is_empty());
    let board = w.board()?;
    assert_eq!(
        (
            board.worker,
            board.until,
            board.dropped_by,
            board.head,
            board.tail
        ),
        (Pubkey::default(), at(60)?, dropper.pubkey(), 2, 4)
    );
    Ok((w, dropper, next))
}

#[test]
fn advance_closes_a_droppers_entry_to_it_while_its_cooldown_holds() -> TestResult {
    let (mut w, dropper, next) = dropped_with_own_entry_behind()?;
    w.set_now(at(59)?);
    let intent = w.intent();
    let owner = w.owner();
    let entries = [w.entry_key(2), w.entry_key(3)];
    assert_eq!(
        w.send(
            &[advance_ix(
                &intent,
                &owner,
                &entries,
                Some(&dropper.pubkey())
            )],
            &[]
        )
        .err(),
        Some(engine_error_at(0, EngineError::StakeAccountMismatch)),
        "the line does not serve the dropper before its term ends"
    );
    assert_eq!(
        w.send(
            &[advance_ix(&intent, &owner, &entries, Some(&next.pubkey()))],
            &[]
        )
        .err(),
        Some(engine_error_at(0, EngineError::StakeAccountMismatch)),
        "the skipped entry is paid only to its worker"
    );
    let rent = w.entry_rent();
    let dropper_before = w.lamports(&dropper.pubkey());
    let next_before = w.lamports(&next.pubkey());
    let board_before = w.lamports(&w.board_key());
    let ix = advance_line_ix(
        &intent,
        &owner,
        &entries,
        Some(&next.pubkey()),
        Some(&dropper.pubkey()),
    );
    let meta = w.send(&[ix], &[]).map_err(|e| format!("{e:?}"))?;
    assert_eq!(
        w.lamports(&dropper.pubkey()),
        sum(&[dropper_before, STAKE, rent])?
    );
    assert_eq!(w.lamports(&next.pubkey()), sum(&[next_before, rent])?);
    assert_eq!(w.lamports(&w.board_key()), sum(&[board_before, STAKE])?);
    assert_eq!(left(&meta), [(dropper.pubkey(), 2, STAKE + rent)]);
    assert_eq!(claimed(&meta), [(next.pubkey(), at(1_259)?, STAKE)]);
    let board = w.board()?;
    assert_eq!(
        (board.worker, board.head, board.dropped_by),
        (next.pubkey(), 4, Pubkey::default())
    );
    w.check_holdings(STAKE)?;
    w.wind_up()
}

#[test]
fn a_dropper_is_served_from_its_entry_once_its_cooldown_has_passed() -> TestResult {
    let (mut w, dropper, next) = dropped_with_own_entry_behind()?;
    assert_eq!(
        w.claim(&dropper, 60).err(),
        Some(engine_error_at(0, EngineError::LineWaiting))
    );
    w.set_now(at(60)?);
    let rent = w.entry_rent();
    let dropper_before = w.lamports(&dropper.pubkey());
    let meta = w.advance()?.map_err(|e| format!("{e:?}"))?;
    assert!(left(&meta).is_empty());
    assert_eq!(claimed(&meta), [(dropper.pubkey(), at(960)?, STAKE)]);
    assert_eq!(w.lamports(&dropper.pubkey()), sum(&[dropper_before, rent])?);
    let board = w.board()?;
    assert_eq!(
        (
            board.worker,
            board.until,
            board.held,
            board.head,
            board.tail
        ),
        (dropper.pubkey(), at(960)?, STAKE, 3, 4)
    );
    assert_eq!(w.front()?, Some(next.pubkey()));
    w.check_holdings(STAKE)?;
    w.wind_up()
}

#[test]
fn a_drop_through_the_world_skips_the_droppers_entries_on_its_own() -> TestResult {
    let mut w = opened()?;
    let first = w.funded()?;
    let dropper = w.funded()?;
    let next = w.funded()?;
    w.claim(&first, HOLD).map_err(|e| format!("{e:?}"))?;
    stand(&mut w, &dropper, 300)?;
    stand(&mut w, &dropper, 900)?;
    stand(&mut w, &dropper, 900)?;
    stand(&mut w, &next, 1_200)?;
    w.drop_claim(&first)?.map_err(|e| format!("{e:?}"))?;
    let meta = w.drop_claim(&dropper)?.map_err(|e| format!("{e:?}"))?;
    let rent = w.entry_rent();
    assert_eq!(
        left(&meta),
        [
            (dropper.pubkey(), 1, STAKE + rent),
            (dropper.pubkey(), 2, STAKE + rent)
        ]
    );
    assert_eq!(w.board()?.worker, next.pubkey());
    w.check_holdings(STAKE)?;
    w.wind_up()
}
