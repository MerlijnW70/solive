#[path = "catalog_class_kit/mod.rs"]
mod kit;

use anchor_lang::error::ErrorCode;
use kit::worlds;
use kit::{foreign_copy, owner_checked, refuses_swap, type_checked, Ready};
use solana_instruction_error::InstructionError;
use solana_transaction_error::TransactionError;
use svm_tests::{anchor_error_at, TestResult};

fn owner(r: TestResult<Ready>, name: &str) -> TestResult {
    let r = r?;
    let key = r.key(name)?;
    owner_checked(r, key)
}

fn cosplay(r: TestResult<Ready>, name: &str, other: &str) -> TestResult {
    let r = r?;
    let key = r.key(name)?;
    let with = r.key(other)?;
    type_checked(r, key, with)
}

fn foreign_program_account(r: TestResult<Ready>, name: &str) -> TestResult {
    let mut r = r?;
    let key = r.key(name)?;
    let fake = foreign_copy(&mut r.env, &key)?;
    refuses_swap(r, key, fake, |at| {
        anchor_error_at(at, ErrorCode::ConstraintOwner)
    })
}

fn mint_cosplay(r: TestResult<Ready>, name: &str) -> TestResult {
    let r = r?;
    let key = r.key(name)?;
    let with = r.key("input")?;
    refuses_swap(r, key, with, |at| {
        TransactionError::InstructionError(at, InstructionError::InvalidAccountData)
    })
}

#[test]
fn owner_checks_init_config_refuse_a_foreign_owner() -> TestResult {
    owner(worlds::init_config(), "program_data")
}

#[test]
fn owner_checks_fill_intent_refuse_a_foreign_owner() -> TestResult {
    owner(worlds::fill_intent(), "intent")
}

#[test]
fn owner_checks_begin_fill_refuse_a_foreign_owner() -> TestResult {
    owner(worlds::begin_fill(), "intent")
}

#[test]
fn owner_checks_end_fill_refuse_a_foreign_owner() -> TestResult {
    let mut r = worlds::end_fill()?;
    let intent = r.key("intent")?;
    let fake = foreign_copy(&mut r.env, &intent)?;
    let alone = kit::swapped(&r.ix, &intent, &fake)?;
    assert_eq!(
        r.run(&[alone]).err(),
        Some(anchor_error_at(0, ErrorCode::AccountOwnedByWrongProgram))
    );
    r.accepts()
}

#[test]
fn owner_checks_fill_attested_refuse_a_foreign_owner() -> TestResult {
    owner(worlds::fill_attested(), "intent")
}

#[test]
fn owner_checks_fill_attested_split_refuse_a_foreign_owner() -> TestResult {
    owner(worlds::fill_attested_split(), "announcement")
}

#[test]
fn owner_checks_fill_attested_committee_refuse_a_foreign_owner() -> TestResult {
    owner(worlds::fill_attested_committee(), "committee")
}

#[test]
fn owner_checks_fill_attested_split_committee_refuse_a_foreign_owner() -> TestResult {
    owner(worlds::fill_attested_split_committee(), "committee")
}

#[test]
fn owner_checks_cancel_intent_refuse_a_foreign_owner() -> TestResult {
    owner(worlds::cancel_intent(), "intent")
}

#[test]
fn owner_checks_expire_intent_refuse_a_foreign_owner() -> TestResult {
    owner(worlds::expire_intent(), "intent")
}

#[test]
fn owner_checks_close_intent_refuse_a_foreign_owner() -> TestResult {
    owner(worlds::close_intent(), "intent")
}

#[test]
fn owner_checks_open_claims_refuse_a_foreign_owner() -> TestResult {
    owner(worlds::open_claims(), "intent")
}

#[test]
fn owner_checks_open_claims_listed_refuse_a_foreign_owner() -> TestResult {
    owner(worlds::open_claims_listed(), "intent")
}

#[test]
fn owner_checks_list_claimants_refuse_a_foreign_owner() -> TestResult {
    owner(worlds::list_claimants(), "intent")
}

#[test]
fn owner_checks_claim_job_refuse_a_foreign_owner() -> TestResult {
    owner(worlds::claim_job(), "intent")
}

#[test]
fn owner_checks_stand_by_refuse_a_foreign_owner() -> TestResult {
    owner(worlds::stand_by(), "intent")
}

#[test]
fn owner_checks_announce_delivery_refuse_a_foreign_owner() -> TestResult {
    owner(worlds::announce_delivery(), "intent")
}

#[test]
fn owner_checks_revoke_mandate_refuse_a_foreign_owner() -> TestResult {
    owner(worlds::revoke_mandate(), "mandate")
}

#[test]
fn owner_checks_create_intent_by_agent_refuse_a_foreign_owner() -> TestResult {
    owner(worlds::create_intent_by_agent(), "mandate")
}

#[test]
fn owner_checks_close_announcement_refuse_a_foreign_owner() -> TestResult {
    owner(worlds::close_announcement_ready(), "announcement")
}

#[test]
fn owner_checks_refute_release_refuse_a_foreign_owner() -> TestResult {
    owner(worlds::refute_release(), "earlier")
}

#[test]
fn owner_checks_sync_committee_keys_refuse_a_foreign_owner() -> TestResult {
    owner(worlds::sync_committee_keys(), "committee")
}

#[test]
fn owner_checks_create_intent_refuse_a_foreign_owner() -> TestResult {
    owner(worlds::create_intent(), "input_mint")
}

#[test]
fn owner_checks_create_intent_signed_refuse_a_foreign_owner() -> TestResult {
    owner(worlds::create_intent_signed(), "input_mint")
}

#[test]
fn owner_checks_create_mandate_refuse_a_foreign_owner() -> TestResult {
    owner(worlds::create_mandate(), "input_mint")
}

#[test]
fn owner_checks_set_mint_cap_refuse_a_foreign_owner() -> TestResult {
    owner(worlds::set_mint_cap(), "input_mint")
}

#[test]
fn owner_checks_set_committee_floor_refuse_a_foreign_owner() -> TestResult {
    owner(worlds::set_committee_floor(), "input_mint")
}

#[test]
fn owner_checks_close_legacy_refuse_a_foreign_owner() -> TestResult {
    foreign_program_account(worlds::close_legacy(), "legacy")
}

#[test]
fn owner_checks_migrate_refuse_a_foreign_owner() -> TestResult {
    foreign_program_account(worlds::migrate(), "legacy")
}

#[test]
fn type_cosplay_fill_intent_refuses_another_account_type() -> TestResult {
    cosplay(worlds::fill_intent(), "intent", "user")
}

#[test]
fn type_cosplay_begin_fill_refuses_another_account_type() -> TestResult {
    cosplay(worlds::begin_fill(), "intent", "user")
}

#[test]
fn type_cosplay_end_fill_refuses_another_account_type() -> TestResult {
    let mut r = worlds::end_fill()?;
    let intent = r.key("intent")?;
    let user = r.key("user")?;
    let alone = kit::swapped(&r.ix, &intent, &user)?;
    assert_eq!(
        r.run(&[alone]).err(),
        Some(anchor_error_at(0, ErrorCode::AccountDiscriminatorMismatch))
    );
    r.accepts()
}

#[test]
fn type_cosplay_fill_attested_refuses_another_account_type() -> TestResult {
    cosplay(worlds::fill_attested(), "intent", "user")
}

#[test]
fn type_cosplay_fill_attested_split_refuses_another_account_type() -> TestResult {
    cosplay(worlds::fill_attested_split(), "announcement", "intent")
}

#[test]
fn type_cosplay_fill_attested_committee_refuses_another_account_type() -> TestResult {
    cosplay(worlds::fill_attested_committee(), "committee", "user")
}

#[test]
fn type_cosplay_fill_attested_split_committee_refuses_another_account_type() -> TestResult {
    cosplay(worlds::fill_attested_split_committee(), "committee", "user")
}

#[test]
fn type_cosplay_cancel_intent_refuses_another_account_type() -> TestResult {
    cosplay(worlds::cancel_intent(), "intent", "user")
}

#[test]
fn type_cosplay_expire_intent_refuses_another_account_type() -> TestResult {
    cosplay(worlds::expire_intent(), "intent", "user")
}

#[test]
fn type_cosplay_close_intent_refuses_another_account_type() -> TestResult {
    cosplay(worlds::close_intent(), "intent", "user")
}

#[test]
fn type_cosplay_open_claims_refuses_another_account_type() -> TestResult {
    cosplay(worlds::open_claims(), "intent", "user")
}

#[test]
fn type_cosplay_open_claims_listed_refuses_another_account_type() -> TestResult {
    cosplay(worlds::open_claims_listed(), "intent", "user")
}

#[test]
fn type_cosplay_list_claimants_refuses_another_account_type() -> TestResult {
    cosplay(worlds::list_claimants(), "intent", "user")
}

#[test]
fn type_cosplay_claim_job_refuses_another_account_type() -> TestResult {
    cosplay(worlds::claim_job(), "intent", "user")
}

#[test]
fn type_cosplay_stand_by_refuses_another_account_type() -> TestResult {
    cosplay(worlds::stand_by(), "intent", "user")
}

#[test]
fn type_cosplay_announce_delivery_refuses_another_account_type() -> TestResult {
    cosplay(worlds::announce_delivery(), "intent", "user")
}

#[test]
fn type_cosplay_revoke_mandate_refuses_another_account_type() -> TestResult {
    cosplay(worlds::revoke_mandate(), "mandate", "user")
}

#[test]
fn type_cosplay_create_intent_by_agent_refuses_another_account_type() -> TestResult {
    cosplay(worlds::create_intent_by_agent(), "mandate", "user")
}

#[test]
fn type_cosplay_close_announcement_refuses_another_account_type() -> TestResult {
    cosplay(worlds::close_announcement_ready(), "announcement", "intent")
}

#[test]
fn type_cosplay_refute_release_refuses_another_account_type() -> TestResult {
    cosplay(worlds::refute_release(), "earlier", "intent")
}

#[test]
fn type_cosplay_sync_committee_keys_refuses_another_account_type() -> TestResult {
    cosplay(worlds::sync_committee_keys(), "committee", "user")
}

#[test]
fn type_cosplay_create_intent_refuses_another_account_type() -> TestResult {
    mint_cosplay(worlds::create_intent(), "output_mint")
}

#[test]
fn type_cosplay_create_intent_signed_refuses_another_account_type() -> TestResult {
    mint_cosplay(worlds::create_intent_signed(), "output_mint")
}

#[test]
fn type_cosplay_create_mandate_refuses_another_account_type() -> TestResult {
    mint_cosplay(worlds::create_mandate(), "output_mint")
}

#[test]
fn type_cosplay_set_mint_cap_refuses_another_account_type() -> TestResult {
    mint_cosplay(worlds::set_mint_cap(), "input_mint")
}

#[test]
fn type_cosplay_set_committee_floor_refuses_another_account_type() -> TestResult {
    mint_cosplay(worlds::set_committee_floor(), "input_mint")
}

#[test]
fn owner_checks_claim_held_refuse_a_foreign_owner() -> TestResult {
    owner(worlds::claim_held(), "announcement")
}

#[test]
fn type_cosplay_claim_held_refuses_another_account_type() -> TestResult {
    cosplay(worlds::claim_held(), "announcement", "intent")
}
