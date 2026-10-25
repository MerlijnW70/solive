use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use anchor_spl::token_2022::spl_token_2022::error::TokenError;
use intent_core::bounty::split_n;
use intent_core::fee::split_fees;
use intent_core::lifecycle::Status;
use intent_engine::errors::EngineError;
use intent_engine::events::{
    FeeWithheld, StakeMoved, STAKE_TO_OWNER, STAKE_TO_WORKER, WITHHELD_JUDGE, WITHHELD_PARTNER,
};
use litesvm::types::TransactionMetadata;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    anchor_error_at, claims_pda, engine_error, engine_error_at, events, token_error_at, Delivery,
    MintExt, ReleasePath, ReleaseTerms, ReleaseWorld, Setting, TestResult, START_TS,
};

const T22: Pubkey = anchor_spl::token_2022::ID;
const MINT: [MintExt; 3] = [
    MintExt::InterestBearing,
    MintExt::MetadataPointer,
    MintExt::Freezable,
];
const FUNDED: u64 = 1_000_000;
const ESCROW: u64 = 100_000;
const JUDGE_FEE: u64 = 1_234;
const PROTOCOL_FEE: u64 = 50;
const NET: u64 = 98_716;
const SHARES: [u64; 2] = [59_230, 39_486];
const WEIGHTS: [u16; 2] = [6_000, 4_000];
const PARTNER_BPS: u16 = 30;
const PARTNER_PROTOCOL_FEE: u64 = 50;
const PARTNER_FEE: u64 = 297;
const PARTNER_NET: u64 = 98_419;
const SPEC: [u8; 32] = [0x5d; 32];
const STAKE: u64 = 50_000_000;
const HELD_SECS: u32 = 3_600;
const LAPSING_SECS: u32 = 600;
const EXPIRES_AT: i64 = START_TS + 3_600;

const TERMS: ReleaseTerms = ReleaseTerms {
    funded: FUNDED,
    escrow: ESCROW,
    judge_fee: JUDGE_FEE,
    spec: SPEC,
    weights: WEIGHTS,
    partner_bps: 0,
};

fn no_memo() -> TransactionError {
    token_error_at(1, TokenError::NoMemo)
}

fn frozen() -> TransactionError {
    token_error_at(1, TokenError::AccountFrozen)
}

fn missing() -> TransactionError {
    anchor_error_at(1, ErrorCode::AccountNotInitialized)
}

fn not_announcer() -> TransactionError {
    engine_error_at(1, EngineError::PayeeNotAnnouncer)
}

fn world(path: ReleasePath, partner_bps: u16) -> TestResult<ReleaseWorld> {
    ReleaseWorld::new(
        &MINT,
        path,
        ReleaseTerms {
            partner_bps,
            ..TERMS
        },
    )
}

fn announced(w: &mut ReleaseWorld) -> TestResult<Delivery> {
    let announcer = w.workers[0].insecure_clone();
    let intent = w.intent();
    let delivery = w.env.announce_for(&announcer, &intent)?;
    w.env.set_now(START_TS + 1_800);
    Ok(delivery)
}

fn set(
    w: &mut ReleaseWorld,
    owner: &solana_keypair::Keypair,
    account: &Pubkey,
    setting: Setting,
) -> TestResult {
    let mint = w.market.input_mint;
    w.env.apply_setting(owner, account, &mint, T22, setting)
}

fn spare(w: &mut ReleaseWorld, owner: &Pubkey) -> TestResult<Pubkey> {
    let mint = w.market.input_mint;
    w.env.create_token_account(&mint, owner, T22)
}

fn recreate(w: &mut ReleaseWorld, owner: &Pubkey) -> TestResult<Pubkey> {
    let mint = w.market.input_mint;
    w.env.create_ata(owner, &mint, T22)
}

fn status(w: &ReleaseWorld) -> TestResult<u8> {
    Ok(w.env.intent(&w.owner(), 0)?.status)
}

fn untouched(w: &ReleaseWorld) -> TestResult {
    assert_eq!(w.env.balance(&w.vault())?, ESCROW, "vault");
    assert_eq!(w.env.balance(&w.fee_to)?, 0, "protocol fee");
    assert_eq!(w.env.balance(&w.trader.input)?, FUNDED - ESCROW, "owner");
    assert_eq!(status(w)?, Status::Open as u8);
    Ok(())
}

fn released(w: &ReleaseWorld, payee: &Pubkey) -> TestResult {
    assert_eq!(w.env.balance(payee)?, NET, "payee");
    assert_eq!(w.env.balance(&w.judge_to)?, JUDGE_FEE, "judge fee");
    assert_eq!(w.env.balance(&w.fee_to)?, PROTOCOL_FEE, "protocol fee");
    assert_eq!(w.env.balance(&w.vault())?, 0, "vault");
    assert_eq!(status(w)?, Status::Filled as u8);
    Ok(())
}

fn split_released(w: &ReleaseWorld) -> TestResult {
    assert_eq!(w.paid()?, SHARES, "recipients");
    assert_eq!(w.env.balance(&w.judge_to)?, JUDGE_FEE, "judge fee");
    assert_eq!(w.env.balance(&w.fee_to)?, PROTOCOL_FEE, "protocol fee");
    assert_eq!(w.env.balance(&w.vault())?, 0, "vault");
    assert_eq!(status(w)?, Status::Filled as u8);
    Ok(())
}

fn owner_refunds(w: &mut ReleaseWorld) -> TestResult {
    let owner = w.owner();
    let market_input = w.trader.input;
    let ix = w.env.cancel_ix(&owner, &w.market, 0, &market_input);
    let key = w.trader.key.insecure_clone();
    w.env.send(&key, &[ix], &[])?;
    assert_eq!(w.env.balance(&market_input)?, FUNDED, "refunded");
    assert_eq!(w.env.balance(&w.vault())?, 0, "vault");
    assert_eq!(status(w)?, Status::Cancelled as u8);
    Ok(())
}

fn withheld(meta: &TransactionMetadata) -> Vec<(Pubkey, Pubkey, u64, u8)> {
    events::<FeeWithheld>(meta)
        .into_iter()
        .map(|e| (e.payee, e.account, e.fee, e.role))
        .collect()
}

fn swept_to_owner(w: &mut ReleaseWorld, kept: u64) -> TestResult {
    let owner = w.owner();
    let input = w.trader.input;
    let cranker = w.env.funded()?;
    let ix = w
        .env
        .close_ix_by(&cranker.pubkey(), &owner, &w.market, 0, &input);
    w.env.send(&cranker, &[ix], &[])?;
    assert_eq!(
        Some(w.env.balance(&input)?),
        (FUNDED - ESCROW).checked_add(kept),
        "swept"
    );
    assert!(!w.env.exists(&w.vault()), "vault closed");
    Ok(())
}

fn emptied_owner_account(w: &mut ReleaseWorld) -> TestResult {
    let owner = w.owner();
    let holding = spare(w, &owner)?;
    let key = w.trader.key.insecure_clone();
    let (input, mint) = (w.trader.input, w.market.input_mint);
    w.env
        .transfer(&key, &input, &mint, &holding, T22, FUNDED - ESCROW)?;
    assert_eq!(w.env.balance(&input)?, 0, "emptied");
    Ok(())
}

fn worker_payee(
    path: ReleasePath,
    setting: Setting,
    refusal: Option<TransactionError>,
) -> TestResult {
    let mut w = world(path, 0)?;
    let delivery = announced(&mut w)?;
    let (worker, payee) = (w.workers[0].insecure_clone(), w.atas[0]);
    set(&mut w, &worker, &payee, setting)?;
    let result = w.release(path, &delivery)?;
    let Some(refusal) = refusal else {
        result?;
        return released(&w, &payee);
    };
    assert_eq!(result.err(), Some(refusal));
    untouched(&w)?;
    assert_eq!(w.env.balance(&w.judge_to)?, 0);
    let other = spare(&mut w, &worker.pubkey())?;
    w.release_to(path, &delivery, &other)??;
    released(&w, &other)
}

fn split_recipient(
    path: ReleasePath,
    setting: Setting,
    refusal: Option<TransactionError>,
) -> TestResult {
    let mut w = world(path, 0)?;
    let delivery = announced(&mut w)?;
    let (worker, recipient) = (w.workers[1].insecure_clone(), w.atas[1]);
    set(&mut w, &worker, &recipient, setting)?;
    let result = w.release(path, &delivery)?;
    let Some(refusal) = refusal else {
        result?;
        return split_released(&w);
    };
    assert_eq!(result.err(), Some(refusal));
    untouched(&w)?;
    assert_eq!(w.env.balance(&w.atas[0])?, 0);
    assert_eq!(w.env.balance(&w.judge_to)?, 0);
    if setting == Setting::Closed {
        recreate(&mut w, &worker.pubkey())?;
        w.release(path, &delivery)??;
        return split_released(&w);
    }
    owner_refunds(&mut w)
}

fn judge_fee(setting: Setting, refusal: Option<TransactionError>) -> TestResult {
    let path = ReleasePath::Attested;
    let mut w = world(path, 0)?;
    let delivery = announced(&mut w)?;
    let (judge, judge_to) = (w.attestor.insecure_clone(), w.judge_to);
    set(&mut w, &judge, &judge_to, setting)?;
    let result = w.release(path, &delivery)?;
    if let Some(refusal) = refusal {
        assert_eq!(result.err(), Some(refusal));
        untouched(&w)?;
        assert_eq!(w.env.balance(&w.atas[0])?, 0);
        recreate(&mut w, &judge.pubkey())?;
        w.release(path, &delivery)??;
        return released(&w, &w.atas[0]);
    }
    let meta = result?;
    assert_eq!(
        withheld(&meta),
        [(judge.pubkey(), judge_to, JUDGE_FEE, WITHHELD_JUDGE)]
    );
    assert_eq!(w.env.balance(&w.atas[0])?, NET, "payee");
    assert_eq!(w.env.balance(&judge_to)?, 0, "judge fee");
    assert_eq!(w.env.balance(&w.fee_to)?, PROTOCOL_FEE, "protocol fee");
    assert_eq!(w.env.balance(&w.vault())?, JUDGE_FEE, "kept");
    swept_to_owner(&mut w, JUDGE_FEE)
}

fn partner_fee(setting: Setting, refusal: Option<TransactionError>) -> TestResult {
    let path = ReleasePath::Attested;
    let mut w = world(path, PARTNER_BPS)?;
    let delivery = announced(&mut w)?;
    let partner = w.partner.insecure_clone();
    let partner_to = w.partner_to.ok_or("no partner account")?;
    set(&mut w, &partner, &partner_to, setting)?;
    let result = w.release(path, &delivery)?;
    let (paid_partner, kept) = if let Some(refusal) = refusal {
        assert_eq!(result.err(), Some(refusal));
        untouched(&w)?;
        assert_eq!(w.env.balance(&w.judge_to)?, 0);
        recreate(&mut w, &partner.pubkey())?;
        let meta = w.release(path, &delivery)??;
        assert!(withheld(&meta).is_empty());
        (PARTNER_FEE, 0)
    } else {
        let meta = result?;
        assert_eq!(
            withheld(&meta),
            [(partner.pubkey(), partner_to, PARTNER_FEE, WITHHELD_PARTNER)]
        );
        (0, PARTNER_FEE)
    };
    assert_eq!(w.env.balance(&w.atas[0])?, PARTNER_NET, "payee");
    assert_eq!(w.env.balance(&w.judge_to)?, JUDGE_FEE, "judge fee");
    assert_eq!(
        w.env.balance(&w.fee_to)?,
        PARTNER_PROTOCOL_FEE,
        "protocol fee"
    );
    assert_eq!(w.env.balance(&partner_to)?, paid_partner, "partner fee");
    assert_eq!(w.env.balance(&w.vault())?, kept, "kept");
    swept_to_owner(&mut w, kept)
}

fn protocol_fee(setting: Setting, refusal: Option<TransactionError>) -> TestResult {
    let path = ReleasePath::Attested;
    let mut w = world(path, 0)?;
    let delivery = announced(&mut w)?;
    let (fee_owner, fee_to) = (w.fee_owner.insecure_clone(), w.fee_to);
    set(&mut w, &fee_owner, &fee_to, setting)?;
    let result = w.release(path, &delivery)?;
    let Some(refusal) = refusal else {
        result?;
        return released(&w, &w.atas[0]);
    };
    assert_eq!(result.err(), Some(refusal));
    assert_eq!(w.env.balance(&w.vault())?, ESCROW, "vault");
    assert_eq!(w.env.balance(&w.atas[0])?, 0);
    assert_eq!(w.env.balance(&w.judge_to)?, 0);
    assert_eq!(status(&w)?, Status::Open as u8);
    if setting == Setting::Closed {
        recreate(&mut w, &fee_owner.pubkey())?;
        w.release(path, &delivery)??;
        return released(&w, &w.atas[0]);
    }
    owner_refunds(&mut w)
}

fn cancel(
    w: &mut ReleaseWorld,
    refund_to: &Pubkey,
) -> TestResult<Result<TransactionMetadata, TransactionError>> {
    let owner = w.owner();
    let ix = w.env.cancel_ix(&owner, &w.market, 0, refund_to);
    let payer = w.env.funded()?;
    let key = w.trader.key.insecure_clone();
    Ok(w.env.send(&payer, &[ix], &[&key]))
}

fn owner_setting(w: &mut ReleaseWorld, setting: Setting) -> TestResult {
    if setting == Setting::Closed {
        emptied_owner_account(w)?;
    }
    let (key, input) = (w.trader.key.insecure_clone(), w.trader.input);
    set(w, &key, &input, setting)
}

fn cancel_refund(setting: Setting, refusal: Option<TransactionError>) -> TestResult {
    let mut w = world(ReleasePath::Attested, 0)?;
    owner_setting(&mut w, setting)?;
    let input = w.trader.input;
    let result = cancel(&mut w, &input)?;
    let Some(refusal) = refusal else {
        result?;
        assert_eq!(w.env.balance(&input)?, FUNDED, "refunded");
        assert_eq!(w.env.balance(&w.vault())?, 0);
        return Ok(());
    };
    assert_eq!(result.err(), Some(refusal));
    assert_eq!(w.env.balance(&w.vault())?, ESCROW, "vault");
    assert_eq!(status(&w)?, Status::Open as u8);
    let owner = w.owner();
    let other = spare(&mut w, &owner)?;
    cancel(&mut w, &other)??;
    assert_eq!(w.env.balance(&other)?, ESCROW, "refunded");
    assert_eq!(w.env.balance(&w.vault())?, 0);
    assert_eq!(status(&w)?, Status::Cancelled as u8);
    Ok(())
}

fn expire(
    w: &mut ReleaseWorld,
    refund_to: &Pubkey,
) -> TestResult<Result<TransactionMetadata, TransactionError>> {
    let owner = w.owner();
    let cranker = w.env.funded()?;
    let ix = w
        .env
        .expire_ix(&cranker.pubkey(), &owner, &w.market, 0, refund_to);
    Ok(w.env.send(&cranker, &[ix], &[]))
}

fn expire_refund(
    setting: Setting,
    canonical: TransactionError,
    elsewhere: Option<TransactionError>,
) -> TestResult {
    let mut w = world(ReleasePath::Attested, 0)?;
    owner_setting(&mut w, setting)?;
    w.env.set_now(EXPIRES_AT);
    let input = w.trader.input;
    assert_eq!(expire(&mut w, &input)?.err(), Some(canonical));
    assert_eq!(w.env.balance(&w.vault())?, ESCROW, "vault");
    assert_eq!(status(&w)?, Status::Open as u8);
    let owner = w.owner();
    let other = spare(&mut w, &owner)?;
    let target = if let Some(refusal) = elsewhere {
        assert_eq!(expire(&mut w, &other)?.err(), Some(refusal));
        assert_eq!(w.env.balance(&w.vault())?, ESCROW, "vault");
        recreate(&mut w, &owner)?
    } else {
        other
    };
    expire(&mut w, &target)??;
    assert_eq!(w.env.balance(&target)?, ESCROW, "refunded");
    assert_eq!(w.env.balance(&w.vault())?, 0);
    assert_eq!(status(&w)?, Status::Expired as u8);
    Ok(())
}

fn stake_moved(meta: &TransactionMetadata) -> Vec<(Pubkey, Pubkey, u64, u8)> {
    events::<StakeMoved>(meta)
        .into_iter()
        .map(|e| (e.worker, e.to, e.amount, e.role))
        .collect()
}

fn stake_returned(setting: Setting, refusal: Option<TransactionError>) -> TestResult {
    let path = ReleasePath::Attested;
    let mut w = world(path, 0)?;
    let (trader, worker) = (w.trader.key.insecure_clone(), w.workers[0].insecure_clone());
    let claimant = worker.pubkey();
    let board = claims_pda(&w.intent());
    w.env.hold_claim(&trader, 0, &worker, HELD_SECS, STAKE)?;
    w.env.claims = Some(board);
    w.env.stake_to = Some(claimant);
    let delivery = announced(&mut w)?;
    let payee = w.atas[0];
    set(&mut w, &worker, &payee, setting)?;
    let (claimant_before, board_before) = (w.env.lamports(&claimant), w.env.lamports(&board));
    let result = w.release(path, &delivery)?;
    let paid_to = if let Some(refusal) = refusal {
        assert_eq!(result.err(), Some(refusal));
        untouched(&w)?;
        assert_eq!(w.env.lamports(&claimant), claimant_before, "stake held");
        assert_eq!(w.env.lamports(&board), board_before, "stake held");
        let other = spare(&mut w, &claimant)?;
        let meta = w.release_to(path, &delivery, &other)??;
        assert_eq!(
            stake_moved(&meta),
            [(claimant, claimant, STAKE, STAKE_TO_WORKER)]
        );
        other
    } else {
        let meta = result?;
        assert_eq!(
            stake_moved(&meta),
            [(claimant, claimant, STAKE, STAKE_TO_WORKER)]
        );
        payee
    };
    released(&w, &paid_to)?;
    assert_eq!(
        w.env.lamports(&claimant).checked_sub(claimant_before),
        Some(STAKE),
        "stake"
    );
    assert_eq!(
        board_before.checked_sub(w.env.lamports(&board)),
        Some(STAKE),
        "board"
    );
    Ok(())
}

fn stake_forfeited(setting: Setting, refusal: Option<TransactionError>) -> TestResult {
    let mut w = world(ReleasePath::Attested, 0)?;
    let (trader, worker) = (w.trader.key.insecure_clone(), w.workers[0].insecure_clone());
    let owner = w.owner();
    let board = claims_pda(&w.intent());
    w.env.hold_claim(&trader, 0, &worker, LAPSING_SECS, STAKE)?;
    w.env.claims = Some(board);
    w.env.stake_to = Some(owner);
    w.env.set_now(START_TS + 1_200);
    owner_setting(&mut w, setting)?;
    let (owner_before, board_before) = (w.env.lamports(&owner), w.env.lamports(&board));
    let input = w.trader.input;
    let result = cancel(&mut w, &input)?;
    let refunded_to = if let Some(refusal) = refusal {
        assert_eq!(result.err(), Some(refusal.clone()));
        assert_eq!(w.env.balance(&w.vault())?, ESCROW, "vault");
        assert_eq!(status(&w)?, Status::Open as u8);
        assert_eq!(w.env.lamports(&owner), owner_before, "stake held");
        assert_eq!(w.env.lamports(&board), board_before, "stake held");
        let other = spare(&mut w, &owner)?;
        let meta = cancel(&mut w, &other)??;
        assert_eq!(
            stake_moved(&meta),
            [(worker.pubkey(), owner, STAKE, STAKE_TO_OWNER)]
        );
        assert_eq!(w.env.balance(&other)?, ESCROW, "refunded");
        other
    } else {
        let meta = result?;
        assert_eq!(
            stake_moved(&meta),
            [(worker.pubkey(), owner, STAKE, STAKE_TO_OWNER)]
        );
        assert_eq!(w.env.balance(&input)?, FUNDED, "refunded");
        input
    };
    assert!(w.env.exists(&refunded_to));
    assert_eq!(w.env.balance(&w.vault())?, 0, "vault");
    assert_eq!(status(&w)?, Status::Cancelled as u8);
    assert_eq!(
        w.env.lamports(&owner).checked_sub(owner_before),
        Some(STAKE),
        "forfeit"
    );
    assert_eq!(
        board_before.checked_sub(w.env.lamports(&board)),
        Some(STAKE),
        "board"
    );
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
    let w = world(ReleasePath::Attested, PARTNER_BPS)?;
    let recorded = w.env.intent(&w.owner(), 0)?;
    let fees = split_fees(
        ESCROW - JUDGE_FEE,
        recorded.fee_bps,
        recorded.partner_bps,
        recorded.partner_cut_bps,
    )
    .map_err(|e| format!("{e:?}"))?;
    assert_eq!(
        (fees.protocol, fees.partner, fees.net),
        (PARTNER_PROTOCOL_FEE, PARTNER_FEE, PARTNER_NET)
    );
    assert_eq!(
        JUDGE_FEE + PARTNER_PROTOCOL_FEE + PARTNER_FEE + PARTNER_NET,
        ESCROW
    );
    Ok(())
}

#[test]
fn attested_release_into_a_payee_that_requires_memos_is_refused_until_the_worker_names_another_account(
) -> TestResult {
    worker_payee(
        ReleasePath::Attested,
        Setting::MemoRequired,
        Some(no_memo()),
    )
}

#[test]
fn attested_release_into_a_payee_with_a_cpi_guard_pays_in_full() -> TestResult {
    worker_payee(ReleasePath::Attested, Setting::CpiGuard, None)
}

#[test]
fn attested_release_into_a_frozen_payee_is_refused_until_the_worker_names_another_account(
) -> TestResult {
    worker_payee(ReleasePath::Attested, Setting::Frozen, Some(frozen()))
}

#[test]
fn attested_release_into_a_closed_payee_is_refused_until_the_worker_names_another_account(
) -> TestResult {
    worker_payee(
        ReleasePath::Attested,
        Setting::Closed,
        Some(not_announcer()),
    )
}

#[test]
fn committee_release_into_a_payee_that_requires_memos_is_refused_until_the_worker_names_another_account(
) -> TestResult {
    worker_payee(
        ReleasePath::Committee,
        Setting::MemoRequired,
        Some(no_memo()),
    )
}

#[test]
fn committee_release_into_a_payee_with_a_cpi_guard_pays_in_full() -> TestResult {
    worker_payee(ReleasePath::Committee, Setting::CpiGuard, None)
}

#[test]
fn committee_release_into_a_frozen_payee_is_refused_until_the_worker_names_another_account(
) -> TestResult {
    worker_payee(ReleasePath::Committee, Setting::Frozen, Some(frozen()))
}

#[test]
fn committee_release_into_a_closed_payee_is_refused_until_the_worker_names_another_account(
) -> TestResult {
    worker_payee(
        ReleasePath::Committee,
        Setting::Closed,
        Some(not_announcer()),
    )
}

#[test]
fn attested_split_with_a_recipient_that_requires_memos_is_refused_and_the_owner_can_still_refund(
) -> TestResult {
    split_recipient(
        ReleasePath::AttestedSplit,
        Setting::MemoRequired,
        Some(no_memo()),
    )
}

#[test]
fn attested_split_with_a_recipient_cpi_guard_pays_every_share() -> TestResult {
    split_recipient(ReleasePath::AttestedSplit, Setting::CpiGuard, None)
}

#[test]
fn attested_split_with_a_frozen_recipient_is_refused_and_the_owner_can_still_refund() -> TestResult
{
    split_recipient(ReleasePath::AttestedSplit, Setting::Frozen, Some(frozen()))
}

#[test]
fn attested_split_with_a_closed_recipient_is_refused_until_anyone_recreates_the_account(
) -> TestResult {
    split_recipient(ReleasePath::AttestedSplit, Setting::Closed, Some(missing()))
}

#[test]
fn committee_split_with_a_recipient_that_requires_memos_is_refused_and_the_owner_can_still_refund(
) -> TestResult {
    split_recipient(
        ReleasePath::CommitteeSplit,
        Setting::MemoRequired,
        Some(no_memo()),
    )
}

#[test]
fn committee_split_with_a_recipient_cpi_guard_pays_every_share() -> TestResult {
    split_recipient(ReleasePath::CommitteeSplit, Setting::CpiGuard, None)
}

#[test]
fn committee_split_with_a_frozen_recipient_is_refused_and_the_owner_can_still_refund() -> TestResult
{
    split_recipient(ReleasePath::CommitteeSplit, Setting::Frozen, Some(frozen()))
}

#[test]
fn committee_split_with_a_closed_recipient_is_refused_until_anyone_recreates_the_account(
) -> TestResult {
    split_recipient(
        ReleasePath::CommitteeSplit,
        Setting::Closed,
        Some(missing()),
    )
}

#[test]
fn a_judge_account_that_requires_memos_has_its_fee_withheld_and_swept_back_to_the_owner(
) -> TestResult {
    judge_fee(Setting::MemoRequired, None)
}

#[test]
fn a_judge_account_with_a_cpi_guard_has_its_fee_withheld_and_swept_back_to_the_owner() -> TestResult
{
    judge_fee(Setting::CpiGuard, None)
}

#[test]
fn a_frozen_judge_account_has_its_fee_withheld_and_swept_back_to_the_owner() -> TestResult {
    judge_fee(Setting::Frozen, None)
}

#[test]
fn a_closed_judge_account_refuses_the_release_until_anyone_recreates_it() -> TestResult {
    judge_fee(Setting::Closed, Some(missing()))
}

#[test]
fn a_partner_account_that_requires_memos_has_its_fee_withheld_and_swept_back_to_the_owner(
) -> TestResult {
    partner_fee(Setting::MemoRequired, None)
}

#[test]
fn a_partner_account_with_a_cpi_guard_has_its_fee_withheld_and_swept_back_to_the_owner(
) -> TestResult {
    partner_fee(Setting::CpiGuard, None)
}

#[test]
fn a_frozen_partner_account_has_its_fee_withheld_and_swept_back_to_the_owner() -> TestResult {
    partner_fee(Setting::Frozen, None)
}

#[test]
fn a_closed_partner_account_refuses_the_release_until_anyone_recreates_it() -> TestResult {
    partner_fee(Setting::Closed, Some(missing()))
}

#[test]
fn a_protocol_fee_account_that_requires_memos_refuses_every_release_and_the_owner_can_still_refund(
) -> TestResult {
    protocol_fee(Setting::MemoRequired, Some(no_memo()))
}

#[test]
fn a_protocol_fee_account_with_a_cpi_guard_is_paid_in_full() -> TestResult {
    protocol_fee(Setting::CpiGuard, None)
}

#[test]
fn a_frozen_protocol_fee_account_refuses_every_release_and_the_owner_can_still_refund() -> TestResult
{
    protocol_fee(Setting::Frozen, Some(frozen()))
}

#[test]
fn a_closed_protocol_fee_account_refuses_the_release_until_anyone_recreates_it() -> TestResult {
    protocol_fee(Setting::Closed, Some(missing()))
}

#[test]
fn cancel_into_an_owner_account_that_requires_memos_is_refused_and_refunds_into_another(
) -> TestResult {
    cancel_refund(
        Setting::MemoRequired,
        Some(token_error_at(0, TokenError::NoMemo)),
    )
}

#[test]
fn cancel_into_an_owner_account_with_a_cpi_guard_refunds_in_full() -> TestResult {
    cancel_refund(Setting::CpiGuard, None)
}

#[test]
fn cancel_into_a_frozen_owner_account_is_refused_and_refunds_into_another() -> TestResult {
    cancel_refund(
        Setting::Frozen,
        Some(token_error_at(0, TokenError::AccountFrozen)),
    )
}

#[test]
fn cancel_into_a_closed_owner_account_is_refused_and_refunds_into_another() -> TestResult {
    cancel_refund(
        Setting::Closed,
        Some(anchor_error_at(0, ErrorCode::AccountNotInitialized)),
    )
}

#[test]
fn expire_into_a_canonical_account_that_requires_memos_is_refused_and_refunds_into_another(
) -> TestResult {
    expire_refund(
        Setting::MemoRequired,
        engine_error(EngineError::RefundCannotReceive),
        None,
    )
}

#[test]
fn expire_into_a_canonical_account_with_a_cpi_guard_is_refused_and_refunds_into_another(
) -> TestResult {
    expire_refund(
        Setting::CpiGuard,
        engine_error(EngineError::RefundCannotReceive),
        None,
    )
}

#[test]
fn expire_into_a_frozen_canonical_account_is_refused_and_refunds_into_another() -> TestResult {
    expire_refund(
        Setting::Frozen,
        engine_error(EngineError::RefundCannotReceive),
        None,
    )
}

#[test]
fn expire_with_a_closed_canonical_account_refunds_only_once_anyone_recreates_it() -> TestResult {
    expire_refund(
        Setting::Closed,
        engine_error(EngineError::RefundCannotReceive),
        Some(engine_error(EngineError::RefundNotCanonical)),
    )
}

#[test]
fn a_held_stake_stays_held_while_the_claimant_payee_requires_memos_and_returns_with_the_release(
) -> TestResult {
    stake_returned(Setting::MemoRequired, Some(no_memo()))
}

#[test]
fn a_held_stake_returns_with_a_release_into_a_payee_with_a_cpi_guard() -> TestResult {
    stake_returned(Setting::CpiGuard, None)
}

#[test]
fn a_held_stake_stays_held_while_the_claimant_payee_is_frozen_and_returns_with_the_release(
) -> TestResult {
    stake_returned(Setting::Frozen, Some(frozen()))
}

#[test]
fn a_held_stake_stays_held_while_the_claimant_payee_is_closed_and_returns_with_the_release(
) -> TestResult {
    stake_returned(Setting::Closed, Some(not_announcer()))
}

#[test]
fn a_lapsed_stake_stays_on_the_board_while_the_refund_account_requires_memos_and_is_forfeited_on_refund(
) -> TestResult {
    stake_forfeited(
        Setting::MemoRequired,
        Some(token_error_at(0, TokenError::NoMemo)),
    )
}

#[test]
fn a_lapsed_stake_is_forfeited_with_a_refund_into_an_account_with_a_cpi_guard() -> TestResult {
    stake_forfeited(Setting::CpiGuard, None)
}

#[test]
fn a_lapsed_stake_stays_on_the_board_while_the_refund_account_is_frozen_and_is_forfeited_on_refund(
) -> TestResult {
    stake_forfeited(
        Setting::Frozen,
        Some(token_error_at(0, TokenError::AccountFrozen)),
    )
}

#[test]
fn a_lapsed_stake_stays_on_the_board_while_the_refund_account_is_closed_and_is_forfeited_on_refund(
) -> TestResult {
    stake_forfeited(
        Setting::Closed,
        Some(anchor_error_at(0, ErrorCode::AccountNotInitialized)),
    )
}
