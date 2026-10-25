#[path = "catalog_class_kit/mod.rs"]
mod kit;

use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use intent_engine::errors::EngineError;
use kit::worlds;
use kit::{refuses_swap, swapped, Ready, HOUR, STAKE};
use solana_signer::Signer;
use svm_tests::{
    anchor_error_at, claims_pda, delegate_pda, engine_error_at, open_claims_ix, TestResult,
};

fn duplicate(at: u8) -> solana_transaction_error::TransactionError {
    anchor_error_at(at, ErrorCode::ConstraintDuplicateMutableAccount)
}

fn alias(r: TestResult<Ready>, from: &str, to: &str) -> TestResult {
    let r = r?;
    let a = r.key(from)?;
    let b = r.key(to)?;
    refuses_swap(r, a, b, duplicate)
}

fn shared(r: TestResult<Ready>, from: &str, to: &str) -> TestResult {
    let r = r?;
    let a = r.key(from)?;
    let b = r.key(to)?;
    refuses_swap(r, a, b, |at| {
        anchor_error_at(at, ErrorCode::ConstraintSeeds)
    })
}

fn second_board(mut r: Ready) -> TestResult<Ready> {
    let owner = r.key("owner")?;
    let other = svm_tests::intent_pda(&owner, 1);
    let open = open_claims_ix(&owner, &other, HOUR, STAKE);
    r.run(&[open])?;
    Ok(r.named("other_board", claims_pda(&other)))
}

fn board_shared(r: TestResult<Ready>) -> TestResult {
    let r = second_board(r?)?;
    shared(Ok(r), "board", "other_board")
}

#[test]
fn duplicate_mutable_accounts_fill_intent_resist_an_aliased_account() -> TestResult {
    alias(worlds::fill_intent(), "solver_output", "receiver")
}

#[test]
fn duplicate_mutable_accounts_end_fill_resist_an_aliased_account() -> TestResult {
    alias(worlds::end_fill(), "solver_output", "receiver")
}

#[test]
fn duplicate_mutable_accounts_cancel_intent_resist_an_aliased_account() -> TestResult {
    let r = worlds::cancel_intent()?;
    let input = r.key("input")?;
    let vault = r.key("vault")?;
    refuses_swap(r, input, vault, duplicate)
}

#[test]
fn duplicate_mutable_accounts_expire_intent_resist_an_aliased_account() -> TestResult {
    let r = worlds::expire_intent()?;
    let input = r.key("input")?;
    let vault = r.key("vault")?;
    let mut r = r;
    let at = r.at();
    let ix = kit::swapped_at(&r.ix, kit::position(&r.ix, &input)?, &vault)?;
    assert_eq!(
        r.refused(ix),
        Some(engine_error_at(at, EngineError::RefundNotCanonical))
    );
    r.accepts()
}

#[test]
fn duplicate_mutable_accounts_close_intent_resist_an_aliased_account() -> TestResult {
    let mut r = worlds::close_intent()?;
    let vault = r.key("vault")?;
    let mint = r.key("input_mint")?;
    let donor = r.env.funded()?;
    let from = r
        .env
        .create_ata(&donor.pubkey(), &mint, anchor_spl::token::ID)?;
    r.env.mint_to(&mint, &from, anchor_spl::token::ID, 25)?;
    r.env
        .transfer(&donor, &from, &mint, &vault, anchor_spl::token::ID, 25)?;
    let input = r.key("input")?;
    let at = r.at();
    let ix = kit::swapped_at(&r.ix, kit::position(&r.ix, &input)?, &vault)?;
    assert_eq!(
        r.refused(ix),
        Some(engine_error_at(at, EngineError::RefundNotCanonical))
    );
    let before = r.env.balance(&input)?;
    r.send()?;
    assert_eq!(r.env.balance(&input)?, before.saturating_add(25));
    Ok(())
}

#[test]
fn duplicate_mutable_accounts_refute_release_resist_an_aliased_account() -> TestResult {
    let mut r = worlds::refute_release()?;
    let paid = r.key("paid")?;
    let earlier = r.key("earlier")?;
    let worker = r.key("worker")?;
    let late = r.key("late")?;
    let same = svm_tests::refutation_pda(&paid);
    let ix = swapped(&r.ix, &earlier, &paid)?;
    let ix = swapped(&ix, &svm_tests::refutation_pda(&earlier), &same)?;
    let ix = swapped(&ix, &worker, &late)?;
    let at = r.at();
    assert_eq!(
        r.refused(ix),
        Some(engine_error_at(at, EngineError::RefuteNotEarlier))
    );
    assert!(!r.env.exists(&same));
    r.accepts()
}

#[test]
fn duplicate_mutable_accounts_fill_attested_split_resist_an_aliased_account() -> TestResult {
    let (mut b, judge) = worlds::proof_base(kit::SPEC)?;
    let solver = b.env.solver(&b.market, 0)?;
    let fee_to = b.env.fee_account(&b.market)?;
    let author = b.env.funded()?;
    let ata = b.env.create_ata(
        &author.pubkey(),
        &b.market.input_mint,
        b.market.input_program,
    )?;
    let intent = b.intent(0);
    let delivery = b.env.announce_for(&author, &intent)?;
    let recipients = [author.pubkey(), author.pubkey()];
    let weights = [5_000u16, 5_000];
    let digest = svm_tests::split_digest(
        svm_tests::DOMAIN,
        &intent,
        kit::ESCROW,
        1,
        kit::SPEC,
        svm_tests::split_commit(&recipients, &weights),
        &delivery,
    );
    let batch = svm_tests::cosign_batch_ix(&[&author, &judge], &digest)?;
    let ix = b.env.fill_attested_split_ix(
        &solver.key.pubkey(),
        &b.owner(),
        &b.market,
        0,
        &recipients,
        &weights,
        Some(&fee_to),
        1,
    );
    let vault = svm_tests::vault_pda(&intent);
    let mut r = b.ready(ix, vec![solver.key.insecure_clone()])?;
    r.before.push(batch);
    assert_eq!(r.send().err(), Some(duplicate(1)));
    assert_eq!(r.env.balance(&ata)?, 0);
    assert_eq!(r.env.balance(&vault)?, kit::ESCROW);
    Ok(())
}

#[test]
fn duplicate_mutable_accounts_begin_fill_resist_an_aliased_account() -> TestResult {
    let mut r = worlds::begin_fill()?;
    let solver_input = r.key("solver_input")?;
    let vault = r.key("vault")?;
    let input = r.key("input")?;
    let receiver = r.key("receiver")?;
    let owner = r.key("owner")?;
    let market = svm_tests::Market {
        input_mint: r.key("input_mint")?,
        output_mint: r.key("output_mint")?,
        input_program: anchor_spl::token::ID,
        output_program: anchor_spl::token::ID,
    };
    let before = r.env.balance(&input)?;
    let ix = swapped(&r.ix, &solver_input, &vault)?;
    r.send_with(ix)?;
    let kept = r.env.balance(&vault)?;
    assert!(kept > 0);
    assert_eq!(r.env.balance(&receiver)?, 1_000);
    let close = r
        .env
        .close_ix_by(&r.payer.pubkey(), &owner, &market, 0, &input);
    r.run(&[close])?;
    assert_eq!(r.env.balance(&input)?, before.saturating_add(kept));
    assert_eq!(r.env.balance(&solver_input)?, 0);
    Ok(())
}

#[test]
fn duplicate_mutable_accounts_fill_attested_split_committee_resist_an_aliased_account() -> TestResult
{
    let r = worlds::fill_attested_split_committee()?;
    let first = r.key("recipient0")?;
    let second = r.key("recipient1")?;
    refuses_swap(r, second, first, duplicate)
}

#[test]
fn pda_sharing_settle_claims_refuses_another_partys_pda() -> TestResult {
    board_shared(worlds::settle_claims())
}

#[test]
fn pda_sharing_fill_intent_refuses_another_partys_pda() -> TestResult {
    shared(worlds::fill_intent(), "vault", "other_vault")
}

#[test]
fn pda_sharing_begin_fill_refuses_another_partys_pda() -> TestResult {
    shared(worlds::begin_fill(), "vault", "other_vault")
}

#[test]
fn pda_sharing_fill_attested_refuses_another_partys_pda() -> TestResult {
    shared(worlds::fill_attested(), "vault", "other_vault")
}

#[test]
fn pda_sharing_fill_attested_split_refuses_another_partys_pda() -> TestResult {
    shared(worlds::fill_attested_split(), "vault", "other_vault")
}

#[test]
fn pda_sharing_fill_attested_committee_refuses_another_partys_pda() -> TestResult {
    shared(worlds::fill_attested_committee(), "vault", "other_vault")
}

#[test]
fn pda_sharing_fill_attested_split_committee_refuses_another_partys_pda() -> TestResult {
    shared(
        worlds::fill_attested_split_committee(),
        "vault",
        "other_vault",
    )
}

#[test]
fn pda_sharing_cancel_intent_refuses_another_partys_pda() -> TestResult {
    shared(worlds::cancel_intent(), "vault", "other_vault")
}

#[test]
fn pda_sharing_expire_intent_refuses_another_partys_pda() -> TestResult {
    shared(worlds::expire_intent(), "vault", "other_vault")
}

#[test]
fn pda_sharing_close_intent_refuses_another_partys_pda() -> TestResult {
    shared(worlds::close_intent(), "vault", "other_vault")
}

#[test]
fn pda_sharing_create_intent_signed_refuses_another_partys_pda() -> TestResult {
    let r = worlds::create_intent_signed()?;
    let owner = r.key("owner")?;
    let other = delegate_pda(&Pubkey::new_unique());
    refuses_swap(r, delegate_pda(&owner), other, |at| {
        anchor_error_at(at, ErrorCode::ConstraintSeeds)
    })
}

#[test]
fn pda_sharing_create_intent_by_agent_refuses_another_partys_pda() -> TestResult {
    let r = worlds::create_intent_by_agent()?;
    let owner = r.key("owner")?;
    let other = delegate_pda(&Pubkey::new_unique());
    refuses_swap(r, delegate_pda(&owner), other, |at| {
        anchor_error_at(at, ErrorCode::ConstraintSeeds)
    })
}

#[test]
fn pda_sharing_claim_job_refuses_another_partys_pda() -> TestResult {
    board_shared(worlds::claim_job())
}

#[test]
fn pda_sharing_drop_claim_refuses_another_partys_pda() -> TestResult {
    board_shared(worlds::drop_claim())
}

#[test]
fn pda_sharing_stand_by_refuses_another_partys_pda() -> TestResult {
    board_shared(worlds::stand_by())
}

#[test]
fn pda_sharing_advance_refuses_another_partys_pda() -> TestResult {
    board_shared(worlds::advance())
}
