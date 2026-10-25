#[path = "catalog_class_kit/mod.rs"]
mod kit;

use kit::worlds;
use kit::{programs_checked, sysvar_checked, Ready};
use svm_tests::TestResult;

fn cpi(r: TestResult<Ready>) -> TestResult {
    programs_checked(r?)
}

fn sysvar(r: TestResult<Ready>) -> TestResult {
    sysvar_checked(r?)
}

#[test]
fn arbitrary_cpi_init_config_refuses_another_program() -> TestResult {
    cpi(worlds::init_config())
}

#[test]
fn arbitrary_cpi_update_config_refuses_another_program() -> TestResult {
    cpi(worlds::update_config())
}

#[test]
fn arbitrary_cpi_update_economics_refuses_another_program() -> TestResult {
    cpi(worlds::update_economics())
}

#[test]
fn arbitrary_cpi_propose_admin_refuses_another_program() -> TestResult {
    cpi(worlds::propose_admin())
}

#[test]
fn arbitrary_cpi_accept_admin_refuses_another_program() -> TestResult {
    cpi(worlds::accept_admin())
}

#[test]
fn arbitrary_cpi_raise_pause_refuses_another_program() -> TestResult {
    cpi(worlds::raise_pause())
}

#[test]
fn arbitrary_cpi_lower_pause_refuses_another_program() -> TestResult {
    cpi(worlds::lower_pause())
}

#[test]
fn arbitrary_cpi_init_user_refuses_another_program() -> TestResult {
    cpi(worlds::init_user())
}

#[test]
fn arbitrary_cpi_advance_nonce_refuses_another_program() -> TestResult {
    cpi(worlds::advance_nonce())
}

#[test]
fn arbitrary_cpi_advance_epoch_refuses_another_program() -> TestResult {
    cpi(worlds::advance_epoch())
}

#[test]
fn arbitrary_cpi_create_intent_refuses_another_program() -> TestResult {
    cpi(worlds::create_intent())
}

#[test]
fn arbitrary_cpi_create_intent_signed_refuses_another_program() -> TestResult {
    cpi(worlds::create_intent_signed())
}

#[test]
fn arbitrary_cpi_create_mandate_refuses_another_program() -> TestResult {
    cpi(worlds::create_mandate())
}

#[test]
fn arbitrary_cpi_revoke_mandate_refuses_another_program() -> TestResult {
    cpi(worlds::revoke_mandate())
}

#[test]
fn arbitrary_cpi_create_intent_by_agent_refuses_another_program() -> TestResult {
    cpi(worlds::create_intent_by_agent())
}

#[test]
fn arbitrary_cpi_fill_attested_refuses_another_program() -> TestResult {
    cpi(worlds::fill_attested())
}

#[test]
fn arbitrary_cpi_fill_attested_split_refuses_another_program() -> TestResult {
    cpi(worlds::fill_attested_split())
}

#[test]
fn arbitrary_cpi_create_committee_refuses_another_program() -> TestResult {
    cpi(worlds::create_committee())
}

#[test]
fn arbitrary_cpi_fill_attested_committee_refuses_another_program() -> TestResult {
    cpi(worlds::fill_attested_committee())
}

#[test]
fn arbitrary_cpi_fill_attested_split_committee_refuses_another_program() -> TestResult {
    cpi(worlds::fill_attested_split_committee())
}

#[test]
fn arbitrary_cpi_open_claims_refuses_another_program() -> TestResult {
    cpi(worlds::open_claims())
}

#[test]
fn arbitrary_cpi_open_claims_listed_refuses_another_program() -> TestResult {
    cpi(worlds::open_claims_listed())
}

#[test]
fn arbitrary_cpi_list_claimants_refuses_another_program() -> TestResult {
    cpi(worlds::list_claimants())
}

#[test]
fn arbitrary_cpi_extend_claimants_refuses_another_program() -> TestResult {
    cpi(worlds::extend_claimants())
}

#[test]
fn arbitrary_cpi_claim_job_refuses_another_program() -> TestResult {
    cpi(worlds::claim_job())
}

#[test]
fn arbitrary_cpi_drop_claim_refuses_another_program() -> TestResult {
    cpi(worlds::drop_claim())
}

#[test]
fn arbitrary_cpi_stand_by_refuses_another_program() -> TestResult {
    cpi(worlds::stand_by())
}

#[test]
fn arbitrary_cpi_announce_delivery_refuses_another_program() -> TestResult {
    cpi(worlds::announce_delivery())
}

#[test]
fn arbitrary_cpi_advance_refuses_another_program() -> TestResult {
    cpi(worlds::advance())
}

#[test]
fn arbitrary_cpi_leave_refuses_another_program() -> TestResult {
    cpi(worlds::leave())
}

#[test]
fn arbitrary_cpi_settle_claims_refuses_another_program() -> TestResult {
    cpi(worlds::settle_claims())
}

#[test]
fn arbitrary_cpi_create_profile_refuses_another_program() -> TestResult {
    cpi(worlds::create_profile())
}

#[test]
fn arbitrary_cpi_update_profile_refuses_another_program() -> TestResult {
    cpi(worlds::update_profile())
}

#[test]
fn arbitrary_cpi_close_profile_refuses_another_program() -> TestResult {
    cpi(worlds::close_profile())
}

#[test]
fn arbitrary_cpi_begin_fill_refuses_another_program() -> TestResult {
    cpi(worlds::begin_fill())
}

#[test]
fn arbitrary_cpi_end_fill_refuses_another_program() -> TestResult {
    cpi(worlds::end_fill())
}

#[test]
fn arbitrary_cpi_fill_intent_refuses_another_program() -> TestResult {
    cpi(worlds::fill_intent())
}

#[test]
fn arbitrary_cpi_cancel_intent_refuses_another_program() -> TestResult {
    cpi(worlds::cancel_intent())
}

#[test]
fn arbitrary_cpi_expire_intent_refuses_another_program() -> TestResult {
    cpi(worlds::expire_intent())
}

#[test]
fn arbitrary_cpi_close_intent_refuses_another_program() -> TestResult {
    cpi(worlds::close_intent())
}

#[test]
fn arbitrary_cpi_set_mint_cap_refuses_another_program() -> TestResult {
    cpi(worlds::set_mint_cap())
}

#[test]
fn arbitrary_cpi_set_caps_required_refuses_another_program() -> TestResult {
    cpi(worlds::set_caps_required())
}

#[test]
fn arbitrary_cpi_set_announce_fee_refuses_another_program() -> TestResult {
    cpi(worlds::set_announce_fee())
}

#[test]
fn arbitrary_cpi_sync_committee_keys_refuses_another_program() -> TestResult {
    cpi(worlds::sync_committee_keys())
}

#[test]
fn arbitrary_cpi_close_announcement_refuses_another_program() -> TestResult {
    cpi(worlds::close_announcement_ready())
}

#[test]
fn arbitrary_cpi_close_delivery_book_refuses_another_program() -> TestResult {
    cpi(worlds::close_delivery_book())
}

#[test]
fn arbitrary_cpi_refute_release_refuses_another_program() -> TestResult {
    cpi(worlds::refute_release())
}

#[test]
fn arbitrary_cpi_set_committee_floor_refuses_another_program() -> TestResult {
    cpi(worlds::set_committee_floor())
}

#[test]
fn arbitrary_cpi_close_legacy_refuses_another_program() -> TestResult {
    cpi(worlds::close_legacy())
}

#[test]
fn arbitrary_cpi_migrate_refuses_another_program() -> TestResult {
    cpi(worlds::migrate())
}

#[test]
fn sysvar_address_checking_create_intent_signed_refuses_a_fake_sysvar() -> TestResult {
    sysvar(worlds::create_intent_signed())
}

#[test]
fn sysvar_address_checking_begin_fill_refuses_a_fake_sysvar() -> TestResult {
    sysvar(worlds::begin_fill())
}

#[test]
fn sysvar_address_checking_fill_attested_refuses_a_fake_sysvar() -> TestResult {
    sysvar(worlds::fill_attested())
}

#[test]
fn sysvar_address_checking_fill_attested_split_refuses_a_fake_sysvar() -> TestResult {
    sysvar(worlds::fill_attested_split())
}

#[test]
fn sysvar_address_checking_fill_attested_committee_refuses_a_fake_sysvar() -> TestResult {
    sysvar(worlds::fill_attested_committee())
}

#[test]
fn sysvar_address_checking_fill_attested_split_committee_refuses_a_fake_sysvar() -> TestResult {
    sysvar(worlds::fill_attested_split_committee())
}
