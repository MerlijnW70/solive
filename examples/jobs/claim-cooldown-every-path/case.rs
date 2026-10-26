use anchor_lang::prelude::Pubkey;
use intent_engine::errors::EngineError;
use solana_signer::Signer;
use svm_tests::{
    claim_job_ix, drop_claim_ix, drop_claim_line_ix, engine_error_at, stand_by_ix, standby_pda,
    ClaimWorld, ReleasePath, ReleaseTerms, TestResult, START_TS,
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

#[test]
fn a_holder_drops_and_takes_the_claim_again_through_its_own_entry() -> TestResult {
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
    w.set_now(START_TS.saturating_add(599));
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
    w.send(&through_line, &[&holder])
        .map_err(|e| format!("{e:?}"))?;
    let board = w.board()?;
    assert_eq!(
        (board.worker, board.held, board.until, board.dropped_by),
        (holder.pubkey(), STAKE, START_TS.saturating_add(3_599), Pubkey::default()),
        "the dropper holds the job again, one second before its term ended, for almost an hour more"
    );
    assert_eq!(w.lamports(&holder.pubkey()), before);
    assert_eq!(w.lamports(&w.board_key()), board_before);
    assert_eq!(
        w.claim(&rival, 60).err(),
        Some(engine_error_at(0, EngineError::ClaimHeld))
    );
    Ok(())
}
