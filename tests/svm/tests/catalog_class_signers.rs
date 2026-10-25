#[path = "catalog_class_kit/mod.rs"]
mod kit;

use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use intent_engine::errors::EngineError;
use kit::worlds;
use kit::{missing_signer, refuses_swap, stranger_signs, Ready};
use solana_signer::Signer;
use svm_tests::{anchor_error_at, engine_error_at, TestResult};

fn signer(r: TestResult<Ready>, name: &str) -> TestResult {
    let r = r?;
    let key = r.key(name)?;
    missing_signer(r, key)
}

fn engine(e: EngineError) -> impl Fn(u8) -> solana_transaction_error::TransactionError {
    move |at| engine_error_at(at, e)
}

fn anchor(e: ErrorCode) -> impl Fn(u8) -> solana_transaction_error::TransactionError {
    move |at| anchor_error_at(at, e)
}

fn stranger(r: TestResult<Ready>, name: &str, e: EngineError) -> TestResult {
    let r = r?;
    let key = r.key(name)?;
    stranger_signs(r, key, engine(e))
}

fn stranger_anchor(r: TestResult<Ready>, name: &str, e: ErrorCode) -> TestResult {
    let r = r?;
    let key = r.key(name)?;
    stranger_signs(r, key, anchor(e))
}

fn substitute(r: TestResult<Ready>, name: &str, e: EngineError) -> TestResult {
    let r = r?;
    let key = r.key(name)?;
    refuses_swap(r, key, Pubkey::new_unique(), engine(e))
}

#[test]
fn signer_authorization_init_config_refuses_a_missing_signature() -> TestResult {
    signer(worlds::init_config(), "admin")
}

#[test]
fn signer_authorization_update_config_refuses_a_missing_signature() -> TestResult {
    signer(worlds::update_config(), "admin")
}

#[test]
fn signer_authorization_update_economics_refuses_a_missing_signature() -> TestResult {
    signer(worlds::update_economics(), "admin")
}

#[test]
fn signer_authorization_propose_admin_refuses_a_missing_signature() -> TestResult {
    signer(worlds::propose_admin(), "admin")
}

#[test]
fn signer_authorization_accept_admin_refuses_a_missing_signature() -> TestResult {
    signer(worlds::accept_admin(), "nominee")
}

#[test]
fn signer_authorization_raise_pause_refuses_a_missing_signature() -> TestResult {
    signer(worlds::raise_pause(), "guardian")
}

#[test]
fn signer_authorization_lower_pause_refuses_a_missing_signature() -> TestResult {
    signer(worlds::lower_pause(), "admin")
}

#[test]
fn signer_authorization_set_mint_cap_refuses_a_missing_signature() -> TestResult {
    signer(worlds::set_mint_cap(), "admin")
}

#[test]
fn signer_authorization_set_caps_required_refuses_a_missing_signature() -> TestResult {
    signer(worlds::set_caps_required(), "admin")
}

#[test]
fn signer_authorization_set_announce_fee_refuses_a_missing_signature() -> TestResult {
    signer(worlds::set_announce_fee(), "admin")
}

#[test]
fn signer_authorization_set_committee_floor_refuses_a_missing_signature() -> TestResult {
    signer(worlds::set_committee_floor(), "admin")
}

#[test]
fn signer_authorization_migrate_refuses_a_missing_signature() -> TestResult {
    signer(worlds::migrate(), "admin")
}

#[test]
fn signer_authorization_init_user_refuses_a_missing_signature() -> TestResult {
    signer(worlds::init_user(), "fresh")
}

#[test]
fn signer_authorization_advance_nonce_refuses_a_missing_signature() -> TestResult {
    signer(worlds::advance_nonce(), "owner")
}

#[test]
fn signer_authorization_advance_epoch_refuses_a_missing_signature() -> TestResult {
    signer(worlds::advance_epoch(), "owner")
}

#[test]
fn signer_authorization_create_intent_refuses_a_missing_signature() -> TestResult {
    signer(worlds::create_intent(), "owner")
}

#[test]
fn signer_authorization_create_intent_signed_refuses_a_missing_signature() -> TestResult {
    signer(worlds::create_intent_signed(), "relayer")
}

#[test]
fn signer_authorization_create_mandate_refuses_a_missing_signature() -> TestResult {
    signer(worlds::create_mandate(), "owner")
}

#[test]
fn signer_authorization_revoke_mandate_refuses_a_missing_signature() -> TestResult {
    signer(worlds::revoke_mandate(), "owner")
}

#[test]
fn signer_authorization_create_intent_by_agent_refuses_a_missing_signature() -> TestResult {
    signer(worlds::create_intent_by_agent(), "agent")
}

#[test]
fn signer_authorization_fill_intent_refuses_a_missing_signature() -> TestResult {
    signer(worlds::fill_intent(), "solver")
}

#[test]
fn signer_authorization_begin_fill_refuses_a_missing_signature() -> TestResult {
    signer(worlds::begin_fill(), "solver")
}

#[test]
fn signer_authorization_end_fill_refuses_a_missing_signature() -> TestResult {
    signer(worlds::end_fill(), "closer")
}

#[test]
fn signer_authorization_cancel_intent_refuses_a_missing_signature() -> TestResult {
    signer(worlds::cancel_intent(), "owner")
}

#[test]
fn signer_authorization_open_claims_refuses_a_missing_signature() -> TestResult {
    signer(worlds::open_claims(), "owner")
}

#[test]
fn signer_authorization_open_claims_listed_refuses_a_missing_signature() -> TestResult {
    signer(worlds::open_claims_listed(), "owner")
}

#[test]
fn signer_authorization_list_claimants_refuses_a_missing_signature() -> TestResult {
    signer(worlds::list_claimants(), "owner")
}

#[test]
fn signer_authorization_extend_claimants_refuses_a_missing_signature() -> TestResult {
    signer(worlds::extend_claimants(), "owner")
}

#[test]
fn signer_authorization_claim_job_refuses_a_missing_signature() -> TestResult {
    signer(worlds::claim_job(), "worker")
}

#[test]
fn signer_authorization_drop_claim_refuses_a_missing_signature() -> TestResult {
    signer(worlds::drop_claim(), "worker")
}

#[test]
fn signer_authorization_stand_by_refuses_a_missing_signature() -> TestResult {
    signer(worlds::stand_by(), "worker")
}

#[test]
fn signer_authorization_leave_refuses_a_missing_signature() -> TestResult {
    signer(worlds::leave(), "worker")
}

#[test]
fn signer_authorization_announce_delivery_refuses_a_missing_signature() -> TestResult {
    signer(worlds::announce_delivery(), "worker")
}

#[test]
fn signer_authorization_close_announcement_refuses_a_missing_signature() -> TestResult {
    signer(worlds::close_announcement_ready(), "worker")
}

#[test]
fn signer_authorization_refute_release_refuses_a_missing_signature() -> TestResult {
    signer(worlds::refute_release(), "worker")
}

#[test]
fn signer_authorization_create_profile_refuses_a_missing_signature() -> TestResult {
    signer(worlds::create_profile(), "wallet")
}

#[test]
fn signer_authorization_update_profile_refuses_a_missing_signature() -> TestResult {
    signer(worlds::update_profile(), "wallet")
}

#[test]
fn signer_authorization_close_profile_refuses_a_missing_signature() -> TestResult {
    signer(worlds::close_profile(), "wallet")
}

#[test]
fn account_data_matching_update_config_refuses_a_mismatched_account() -> TestResult {
    stranger(worlds::update_config(), "admin", EngineError::Unauthorized)
}

#[test]
fn account_data_matching_update_economics_refuses_a_mismatched_account() -> TestResult {
    stranger(
        worlds::update_economics(),
        "admin",
        EngineError::Unauthorized,
    )
}

#[test]
fn account_data_matching_propose_admin_refuses_a_mismatched_account() -> TestResult {
    stranger(worlds::propose_admin(), "admin", EngineError::Unauthorized)
}

#[test]
fn account_data_matching_accept_admin_refuses_a_mismatched_account() -> TestResult {
    stranger(
        worlds::accept_admin(),
        "nominee",
        EngineError::NotPendingAdmin,
    )
}

#[test]
fn account_data_matching_raise_pause_refuses_a_mismatched_account() -> TestResult {
    stranger(worlds::raise_pause(), "guardian", EngineError::Unauthorized)
}

#[test]
fn account_data_matching_lower_pause_refuses_a_mismatched_account() -> TestResult {
    stranger(worlds::lower_pause(), "admin", EngineError::Unauthorized)
}

#[test]
fn account_data_matching_set_mint_cap_refuses_a_mismatched_account() -> TestResult {
    stranger(worlds::set_mint_cap(), "admin", EngineError::Unauthorized)
}

#[test]
fn account_data_matching_set_caps_required_refuses_a_mismatched_account() -> TestResult {
    stranger(
        worlds::set_caps_required(),
        "admin",
        EngineError::Unauthorized,
    )
}

#[test]
fn account_data_matching_set_announce_fee_refuses_a_mismatched_account() -> TestResult {
    stranger(
        worlds::set_announce_fee(),
        "admin",
        EngineError::Unauthorized,
    )
}

#[test]
fn account_data_matching_set_committee_floor_refuses_a_mismatched_account() -> TestResult {
    stranger(
        worlds::set_committee_floor(),
        "admin",
        EngineError::Unauthorized,
    )
}

#[test]
fn account_data_matching_migrate_refuses_a_mismatched_account() -> TestResult {
    stranger(worlds::migrate(), "admin", EngineError::Unauthorized)
}

#[test]
fn account_data_matching_init_user_refuses_a_mismatched_account() -> TestResult {
    stranger_anchor(worlds::init_user(), "fresh", ErrorCode::ConstraintSeeds)
}

#[test]
fn account_data_matching_advance_nonce_refuses_a_mismatched_account() -> TestResult {
    stranger_anchor(worlds::advance_nonce(), "owner", ErrorCode::ConstraintSeeds)
}

#[test]
fn account_data_matching_advance_epoch_refuses_a_mismatched_account() -> TestResult {
    stranger_anchor(worlds::advance_epoch(), "owner", ErrorCode::ConstraintSeeds)
}

#[test]
fn account_data_matching_create_mandate_refuses_a_mismatched_account() -> TestResult {
    let mut r = worlds::create_mandate()?;
    let input = r.key("input")?;
    let thief = r.env.funded()?;
    let mint = r.key("input_mint")?;
    let loot = r
        .env
        .create_token_account(&mint, &thief.pubkey(), anchor_spl::token::ID)?;
    refuses_swap(r, input, loot, anchor(ErrorCode::ConstraintTokenOwner))
}

#[test]
fn account_data_matching_revoke_mandate_refuses_a_mismatched_account() -> TestResult {
    stranger(worlds::revoke_mandate(), "owner", EngineError::Unauthorized)
}

#[test]
fn account_data_matching_cancel_intent_refuses_a_mismatched_account() -> TestResult {
    let r = worlds::cancel_intent()?;
    let owner = r.key("owner")?;
    let mut r = r;
    let thief = r.env.funded()?;
    let mint = r.key("input_mint")?;
    let loot = r
        .env
        .create_token_account(&mint, &thief.pubkey(), anchor_spl::token::ID)?;
    let ix = kit::swapped(
        &kit::swapped(&r.ix, &owner, &thief.pubkey())?,
        &r.key("input")?,
        &loot,
    )?;
    r.keys.push(thief);
    let at = r.at();
    assert_eq!(
        r.refused(ix),
        Some(engine_error_at(at, EngineError::Unauthorized))
    );
    r.accepts()
}

#[test]
fn account_data_matching_end_fill_refuses_a_mismatched_account() -> TestResult {
    let mut r = worlds::end_fill()?;
    let receiver = r.key("receiver")?;
    let thief = r.env.funded()?;
    let mint = r.key("output_mint")?;
    let loot = r
        .env
        .create_token_account(&mint, &thief.pubkey(), anchor_spl::token::ID)?;
    refuses_swap(r, receiver, loot, anchor(ErrorCode::ConstraintHasOne))
}

#[test]
fn account_data_matching_begin_fill_refuses_a_mismatched_account() -> TestResult {
    let mut r = worlds::begin_fill()?;
    let fee_to = r.key("fee_to")?;
    let thief = r.env.funded()?;
    let mint = r.key("input_mint")?;
    let loot = r
        .env
        .create_token_account(&mint, &thief.pubkey(), anchor_spl::token::ID)?;
    refuses_swap(r, fee_to, loot, engine(EngineError::FeeAccountNotCanonical))
}

#[test]
fn account_data_matching_open_claims_refuses_a_mismatched_account() -> TestResult {
    stranger(worlds::open_claims(), "owner", EngineError::Unauthorized)
}

#[test]
fn account_data_matching_open_claims_listed_refuses_a_mismatched_account() -> TestResult {
    stranger(
        worlds::open_claims_listed(),
        "owner",
        EngineError::Unauthorized,
    )
}

#[test]
fn account_data_matching_list_claimants_refuses_a_mismatched_account() -> TestResult {
    stranger(worlds::list_claimants(), "owner", EngineError::Unauthorized)
}

#[test]
fn account_data_matching_extend_claimants_refuses_a_mismatched_account() -> TestResult {
    stranger(
        worlds::extend_claimants(),
        "owner",
        EngineError::Unauthorized,
    )
}

#[test]
fn account_data_matching_claim_job_refuses_a_mismatched_account() -> TestResult {
    substitute(
        worlds::claim_job(),
        "owner",
        EngineError::StakeAccountMismatch,
    )
}

#[test]
fn account_data_matching_drop_claim_refuses_a_mismatched_account() -> TestResult {
    stranger(worlds::drop_claim(), "worker", EngineError::NotClaimant)
}

#[test]
fn account_data_matching_stand_by_refuses_a_mismatched_account() -> TestResult {
    let r = worlds::stand_by()?;
    let entry = r.key("entry")?;
    let intent = r.key("intent")?;
    let later = svm_tests::standby_pda(&intent, 1);
    refuses_swap(r, entry, later, engine(EngineError::LineEntryMismatch))
}

#[test]
fn account_data_matching_advance_refuses_a_mismatched_account() -> TestResult {
    substitute(
        worlds::advance(),
        "owner",
        EngineError::StakeAccountMismatch,
    )
}

#[test]
fn account_data_matching_leave_refuses_a_mismatched_account() -> TestResult {
    let r = worlds::leave()?;
    let worker = r.key("worker")?;
    let mut r = r;
    let caller = r.env.funded()?;
    let mut ix = r.ix.clone();
    if let Some(meta) = ix.accounts.first_mut() {
        meta.pubkey = caller.pubkey();
    }
    r.keys.push(caller);
    let at = r.at();
    assert_eq!(
        r.refused(ix),
        Some(engine_error_at(at, EngineError::Unauthorized))
    );
    let moved = kit::swapped_at(&r.ix, 3, &Pubkey::new_unique())?;
    assert_eq!(
        r.refused(moved),
        Some(engine_error_at(at, EngineError::StakeAccountMismatch))
    );
    let _ = worker;
    r.accepts()
}

#[test]
fn account_data_matching_settle_claims_refuses_a_mismatched_account() -> TestResult {
    substitute(
        worlds::settle_claims(),
        "owner",
        EngineError::StakeAccountMismatch,
    )
}

#[test]
fn account_data_matching_close_announcement_refuses_a_mismatched_account() -> TestResult {
    let r = worlds::close_announcement_ready()?;
    let worker = r.key("worker")?;
    let mut r = r;
    let at = r.at();
    let moved = kit::swapped_at(&r.ix, 4, &Pubkey::new_unique())?;
    assert_eq!(
        r.refused(moved),
        Some(engine_error_at(at, EngineError::RentRecipientMismatch))
    );
    let stranger = r.env.funded()?;
    let mut ix = r.ix.clone();
    if let Some(meta) = ix.accounts.first_mut() {
        meta.pubkey = stranger.pubkey();
    }
    r.keys.push(stranger);
    assert_eq!(
        r.refused(ix),
        Some(engine_error_at(at, EngineError::AnnouncementRetained))
    );
    let _ = worker;
    r.accepts()
}

#[test]
fn account_data_matching_close_delivery_book_refuses_a_mismatched_account() -> TestResult {
    substitute(
        worlds::close_delivery_book(),
        "worker",
        EngineError::RentRecipientMismatch,
    )
}

#[test]
fn account_data_matching_refute_release_refuses_a_mismatched_account() -> TestResult {
    stranger(
        worlds::refute_release(),
        "worker",
        EngineError::RefuteNotAnnouncer,
    )
}

#[test]
fn account_data_matching_create_profile_refuses_a_mismatched_account() -> TestResult {
    stranger_anchor(
        worlds::create_profile(),
        "wallet",
        ErrorCode::ConstraintSeeds,
    )
}

#[test]
fn account_data_matching_update_profile_refuses_a_mismatched_account() -> TestResult {
    stranger_anchor(
        worlds::update_profile(),
        "wallet",
        ErrorCode::ConstraintSeeds,
    )
}

#[test]
fn account_data_matching_close_profile_refuses_a_mismatched_account() -> TestResult {
    stranger_anchor(
        worlds::close_profile(),
        "wallet",
        ErrorCode::ConstraintSeeds,
    )
}

#[test]
fn account_data_matching_close_legacy_refuses_a_mismatched_account() -> TestResult {
    substitute(
        worlds::close_legacy(),
        "wallet",
        EngineError::LegacyPayeeMismatch,
    )
}

#[test]
fn account_data_matching_fill_attested_split_committee_refuses_a_mismatched_account() -> TestResult
{
    let mut r = worlds::fill_attested_split_committee()?;
    let committee = r.key("committee")?;
    let other = r.env.convene(3, 2)?;
    refuses_swap(
        r,
        committee,
        other.address,
        engine(EngineError::CommitteeMismatch),
    )
}
