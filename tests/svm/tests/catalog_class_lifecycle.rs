#[path = "catalog_class_kit/mod.rs"]
mod kit;

use anchor_lang::error::ErrorCode;
use intent_engine::errors::EngineError;
use intent_engine::state::{
    ANNOUNCEMENT_SEED, CLAIMS_SEED, CLAIM_LIST_SEED, COMMITTEE_SEED, CONFIG_SEED, DELEGATE_SEED,
    DELIVERY_BOOK_SEED, INTENT_SEED, MANDATE_SEED, MINT_CAP_SEED, PROFILE_SEED, REFUTATION_SEED,
    USER_SEED, VAULT_SEED,
};
use kit::worlds;
use kit::{fund, gone, off_bump, refuses_swap, transfer_ix, Ready};
use solana_transaction_error::TransactionError;
use svm_tests::{anchor_error_at, engine_error_at, TestResult};

fn data(r: &Ready, name: &str) -> TestResult<Vec<u8>> {
    let key = r.key(name)?;
    Ok(r.env.svm.get_account(&key).ok_or("no account")?.data)
}

fn twice(r: TestResult<Ready>, name: &str) -> TestResult<Option<TransactionError>> {
    let mut r = r?;
    r.send()?;
    let before = data(&r, name)?;
    let again = r.send().err();
    assert!(again.is_some(), "a second creation must be refused");
    assert_eq!(data(&r, name)?, before);
    Ok(again)
}

fn already_in_use(at: u8) -> Option<TransactionError> {
    Some(TransactionError::InstructionError(
        at,
        solana_instruction_error::InstructionError::Custom(0),
    ))
}

fn prefunded(r: TestResult<Ready>, name: &str) -> TestResult {
    let mut r = r?;
    let key = r.key(name)?;
    fund(&mut r.env, &key, 1_000_000)?;
    r.accepts()
}

fn off(r: TestResult<Ready>, name: &str, seeds: &[&[u8]]) -> TestResult {
    let r = r?;
    let key = r.key(name)?;
    let moved = off_bump(seeds)?;
    refuses_swap(r, key, moved, |at| {
        anchor_error_at(at, ErrorCode::ConstraintSeeds)
    })
}

fn revival(r: TestResult<Ready>, names: &[&str]) -> TestResult {
    let mut r = r?;
    let mut keys = Vec::new();
    for name in names {
        keys.push(r.key(name)?);
    }
    let payer = r.payer.insecure_clone();
    let mut ixs = r.before.clone();
    ixs.push(r.ix.clone());
    for key in &keys {
        ixs.push(transfer_ix(
            &solana_signer::Signer::pubkey(&payer),
            key,
            10_000_000,
        ));
    }
    r.run(&ixs)?;
    for key in &keys {
        assert!(
            gone(&r.env, key),
            "a refunded closed account stays empty and system owned"
        );
        assert_eq!(r.env.lamports(key), 10_000_000);
    }
    assert!(r.send().is_err(), "the closed account cannot be used again");
    Ok(())
}

#[test]
fn reinitialization_init_config_refuses_a_second_creation() -> TestResult {
    assert_eq!(twice(worlds::init_config(), "config")?, already_in_use(0));
    Ok(())
}

#[test]
fn reinitialization_init_user_refuses_a_second_creation() -> TestResult {
    assert_eq!(twice(worlds::init_user(), "fresh_user")?, already_in_use(0));
    Ok(())
}

#[test]
fn reinitialization_create_intent_refuses_a_second_creation() -> TestResult {
    assert_eq!(twice(worlds::create_intent(), "intent")?, already_in_use(0));
    Ok(())
}

#[test]
fn reinitialization_create_mandate_refuses_a_second_creation() -> TestResult {
    assert_eq!(
        twice(worlds::create_mandate(), "mandate")?,
        already_in_use(0)
    );
    Ok(())
}

#[test]
fn reinitialization_create_committee_refuses_a_second_creation() -> TestResult {
    assert_eq!(
        twice(worlds::create_committee(), "committee")?,
        already_in_use(0)
    );
    Ok(())
}

#[test]
fn reinitialization_open_claims_refuses_a_second_creation() -> TestResult {
    assert_eq!(twice(worlds::open_claims(), "board")?, already_in_use(0));
    Ok(())
}

#[test]
fn reinitialization_open_claims_listed_refuses_a_second_creation() -> TestResult {
    assert_eq!(
        twice(worlds::open_claims_listed(), "board")?,
        already_in_use(0)
    );
    Ok(())
}

#[test]
fn reinitialization_list_claimants_refuses_a_second_creation() -> TestResult {
    assert_eq!(twice(worlds::list_claimants(), "board")?, already_in_use(0));
    Ok(())
}

#[test]
fn reinitialization_stand_by_refuses_a_second_creation() -> TestResult {
    assert_eq!(
        twice(worlds::stand_by(), "entry")?,
        Some(engine_error_at(0, EngineError::LineEntryMismatch))
    );
    Ok(())
}

#[test]
fn reinitialization_announce_delivery_refuses_a_second_creation() -> TestResult {
    assert_eq!(
        twice(worlds::announce_delivery(), "book")?,
        already_in_use(0)
    );
    Ok(())
}

#[test]
fn reinitialization_refute_release_refuses_a_second_creation() -> TestResult {
    let r = worlds::refute_release()?;
    let earlier = r.key("earlier")?;
    let r = r.named("refutation", svm_tests::refutation_pda(&earlier));
    assert_eq!(twice(Ok(r), "refutation")?, already_in_use(0));
    Ok(())
}

#[test]
fn reinitialization_create_profile_refuses_a_second_creation() -> TestResult {
    assert_eq!(
        twice(worlds::create_profile(), "profile")?,
        already_in_use(0)
    );
    Ok(())
}

#[test]
fn reinitialization_set_mint_cap_refuses_a_second_creation() -> TestResult {
    let mut r = worlds::set_mint_cap()?;
    r.send()?;
    let cap = r.key("mint_cap")?;
    let before: intent_engine::state::MintCap = svm_tests::load(&r.env.svm, &cap)?;
    r.send()?;
    let after: intent_engine::state::MintCap = svm_tests::load(&r.env.svm, &cap)?;
    assert_eq!(
        (
            after.window_start,
            after.window_used,
            after.outstanding,
            after.created_at
        ),
        (
            before.window_start,
            before.window_used,
            before.outstanding,
            before.created_at
        )
    );
    Ok(())
}

#[test]
fn reinitialization_migrate_refuses_a_second_creation() -> TestResult {
    assert_eq!(
        twice(worlds::migrate(), "legacy")?,
        Some(engine_error_at(0, EngineError::AlreadyCurrent))
    );
    Ok(())
}

#[test]
fn insecure_initialization_init_user_survives_lamports_sent_ahead() -> TestResult {
    prefunded(worlds::init_user(), "fresh_user")
}

#[test]
fn insecure_initialization_create_intent_survives_lamports_sent_ahead() -> TestResult {
    prefunded(worlds::create_intent(), "vault")
}

#[test]
fn insecure_initialization_create_intent_signed_survives_lamports_sent_ahead() -> TestResult {
    prefunded(worlds::create_intent_signed(), "vault")
}

#[test]
fn insecure_initialization_create_intent_by_agent_survives_lamports_sent_ahead() -> TestResult {
    let r = worlds::create_intent_by_agent()?;
    let owner = r.key("owner")?;
    let intent = svm_tests::intent_pda(&owner, svm_tests::agent_lane(1, 0));
    let r = r.named("agent_vault", svm_tests::vault_pda(&intent));
    prefunded(Ok(r), "agent_vault")
}

#[test]
fn insecure_initialization_open_claims_listed_survives_lamports_sent_ahead() -> TestResult {
    prefunded(worlds::open_claims_listed(), "board")
}

#[test]
fn insecure_initialization_list_claimants_survives_lamports_sent_ahead() -> TestResult {
    prefunded(worlds::list_claimants(), "list")
}

#[test]
fn insecure_initialization_create_mandate_survives_lamports_sent_ahead() -> TestResult {
    prefunded(worlds::create_mandate(), "mandate")
}

#[test]
fn insecure_initialization_create_committee_survives_lamports_sent_ahead() -> TestResult {
    prefunded(worlds::create_committee(), "committee")
}

#[test]
fn insecure_initialization_open_claims_survives_lamports_sent_ahead() -> TestResult {
    prefunded(worlds::open_claims(), "board")
}

#[test]
fn insecure_initialization_stand_by_survives_lamports_sent_ahead() -> TestResult {
    prefunded(worlds::stand_by(), "entry")
}

#[test]
fn insecure_initialization_announce_delivery_survives_lamports_sent_ahead() -> TestResult {
    prefunded(worlds::announce_delivery(), "book")
}

#[test]
fn insecure_initialization_create_profile_survives_lamports_sent_ahead() -> TestResult {
    prefunded(worlds::create_profile(), "profile")
}

#[test]
fn insecure_initialization_set_mint_cap_survives_lamports_sent_ahead() -> TestResult {
    prefunded(worlds::set_mint_cap(), "mint_cap")
}

#[test]
fn insecure_initialization_refute_release_survives_lamports_sent_ahead() -> TestResult {
    let r = worlds::refute_release()?;
    let earlier = r.key("earlier")?;
    let r = r.named("refutation", svm_tests::refutation_pda(&earlier));
    prefunded(Ok(r), "refutation")
}

#[test]
fn bump_seed_canonicalization_init_config_refuses_a_noncanonical_bump() -> TestResult {
    off(worlds::init_config(), "config", &[CONFIG_SEED])
}

#[test]
fn bump_seed_canonicalization_init_user_refuses_a_noncanonical_bump() -> TestResult {
    let r = worlds::init_user()?;
    let fresh = r.key("fresh")?;
    off(Ok(r), "fresh_user", &[USER_SEED, fresh.as_ref()])
}

#[test]
fn bump_seed_canonicalization_create_intent_refuses_a_noncanonical_bump() -> TestResult {
    let nonce = 0u64.to_le_bytes();
    let r = worlds::create_intent()?;
    let owner = r.key("owner")?;
    off(Ok(r), "intent", &[INTENT_SEED, owner.as_ref(), &nonce])?;
    let r = worlds::create_intent()?;
    let intent = r.key("intent")?;
    off(Ok(r), "vault", &[VAULT_SEED, intent.as_ref()])
}

#[test]
fn bump_seed_canonicalization_create_intent_signed_refuses_a_noncanonical_bump() -> TestResult {
    let nonce = 0u64.to_le_bytes();
    let r = worlds::create_intent_signed()?;
    let owner = r.key("owner")?;
    off(Ok(r), "intent", &[INTENT_SEED, owner.as_ref(), &nonce])?;
    let r = worlds::create_intent_signed()?;
    let owner = r.key("owner")?;
    let r = r.named("delegate", svm_tests::delegate_pda(&owner));
    off(Ok(r), "delegate", &[DELEGATE_SEED, owner.as_ref()])
}

#[test]
fn bump_seed_canonicalization_create_intent_by_agent_refuses_a_noncanonical_bump() -> TestResult {
    let lane = svm_tests::agent_lane(1, 0);
    let nonce = lane.to_le_bytes();
    let r = worlds::create_intent_by_agent()?;
    let owner = r.key("owner")?;
    let r = r.named("agent_intent", svm_tests::intent_pda(&owner, lane));
    off(
        Ok(r),
        "agent_intent",
        &[INTENT_SEED, owner.as_ref(), &nonce],
    )?;
    let r = worlds::create_intent_by_agent()?;
    let owner = r.key("owner")?;
    let r = r.named("delegate", svm_tests::delegate_pda(&owner));
    off(Ok(r), "delegate", &[DELEGATE_SEED, owner.as_ref()])
}

#[test]
fn bump_seed_canonicalization_create_mandate_refuses_a_noncanonical_bump() -> TestResult {
    let r = worlds::create_mandate()?;
    let owner = r.key("owner")?;
    let agent = r.key("agent")?;
    let id = 0u64.to_le_bytes();
    off(
        Ok(r),
        "mandate",
        &[MANDATE_SEED, owner.as_ref(), agent.as_ref(), &id],
    )
}

#[test]
fn bump_seed_canonicalization_create_committee_refuses_a_noncanonical_bump() -> TestResult {
    let r = worlds::create_committee()?;
    let id: [u8; 32] = r.ix.data.get(8..40).ok_or("id")?.try_into()?;
    off(Ok(r), "committee", &[COMMITTEE_SEED, &id])
}

#[test]
fn bump_seed_canonicalization_open_claims_refuses_a_noncanonical_bump() -> TestResult {
    let r = worlds::open_claims()?;
    let intent = r.key("intent")?;
    off(Ok(r), "board", &[CLAIMS_SEED, intent.as_ref()])
}

#[test]
fn bump_seed_canonicalization_open_claims_listed_refuses_a_noncanonical_bump() -> TestResult {
    let r = worlds::open_claims_listed()?;
    let intent = r.key("intent")?;
    let list = svm_tests::claim_list_pda(&intent);
    let r = r.named("list", list);
    off(Ok(r), "list", &[CLAIM_LIST_SEED, intent.as_ref()])
}

#[test]
fn bump_seed_canonicalization_list_claimants_refuses_a_noncanonical_bump() -> TestResult {
    let r = worlds::list_claimants()?;
    let intent = r.key("intent")?;
    let list = svm_tests::claim_list_pda(&intent);
    let r = r.named("list", list);
    off(Ok(r), "list", &[CLAIM_LIST_SEED, intent.as_ref()])
}

#[test]
fn bump_seed_canonicalization_stand_by_refuses_a_noncanonical_bump() -> TestResult {
    let r = worlds::stand_by()?;
    let intent = r.key("intent")?;
    let entry = r.key("entry")?;
    let seq = 0u32.to_le_bytes();
    let moved = off_bump(&[intent_engine::state::STANDBY_SEED, intent.as_ref(), &seq])?;
    refuses_swap(r, entry, moved, |at| {
        engine_error_at(at, EngineError::LineEntryMismatch)
    })
}

#[test]
fn bump_seed_canonicalization_announce_delivery_refuses_a_noncanonical_bump() -> TestResult {
    let r = worlds::announce_delivery()?;
    let intent = r.key("intent")?;
    off(Ok(r), "book", &[DELIVERY_BOOK_SEED, intent.as_ref()])?;
    let r = worlds::announce_delivery()?;
    let worker = r.key("worker")?;
    let announce = announcement_seed(&r)?;
    off(
        Ok(r),
        "announcement",
        &[
            ANNOUNCEMENT_SEED,
            intent.as_ref(),
            worker.as_ref(),
            &announce,
        ],
    )
}

fn announcement_seed(r: &Ready) -> TestResult<[u8; 32]> {
    let data = &r.ix.data;
    let len_at = 8usize.checked_add(32).ok_or("offset")?;
    let len_bytes: [u8; 4] = data
        .get(len_at..len_at.checked_add(4).ok_or("offset")?)
        .ok_or("len")?
        .try_into()?;
    let len = usize::try_from(u32::from_le_bytes(len_bytes))?;
    let start = len_at.checked_add(4).ok_or("offset")?;
    let blob = data
        .get(start..start.checked_add(len).ok_or("offset")?)
        .ok_or("blob")?;
    Ok(intent_engine::delivery::blob_digest(blob))
}

#[test]
fn bump_seed_canonicalization_refute_release_refuses_a_noncanonical_bump() -> TestResult {
    let r = worlds::refute_release()?;
    let earlier = r.key("earlier")?;
    let r = r.named("refutation", svm_tests::refutation_pda(&earlier));
    off(Ok(r), "refutation", &[REFUTATION_SEED, earlier.as_ref()])
}

#[test]
fn bump_seed_canonicalization_create_profile_refuses_a_noncanonical_bump() -> TestResult {
    let r = worlds::create_profile()?;
    let wallet = r.key("wallet")?;
    off(Ok(r), "profile", &[PROFILE_SEED, wallet.as_ref()])
}

#[test]
fn bump_seed_canonicalization_set_mint_cap_refuses_a_noncanonical_bump() -> TestResult {
    let r = worlds::set_mint_cap()?;
    let mint = r.key("input_mint")?;
    off(Ok(r), "mint_cap", &[MINT_CAP_SEED, mint.as_ref()])
}

#[test]
fn closing_accounts_revoke_mandate_leaves_no_revivable_account() -> TestResult {
    revival(worlds::revoke_mandate(), &["mandate"])
}

#[test]
fn closing_accounts_close_intent_leaves_no_revivable_account() -> TestResult {
    revival(worlds::close_intent(), &["intent", "vault"])
}

#[test]
fn closing_accounts_close_profile_leaves_no_revivable_account() -> TestResult {
    revival(worlds::close_profile(), &["profile"])
}

#[test]
fn closing_accounts_leave_leaves_no_revivable_account() -> TestResult {
    revival(worlds::leave(), &["entry"])
}

#[test]
fn closing_accounts_advance_leaves_no_revivable_account() -> TestResult {
    revival(worlds::advance(), &["entry"])
}

#[test]
fn closing_accounts_drop_claim_leaves_no_revivable_account() -> TestResult {
    let (b, holder, waiter) = worlds::waiting_base()?;
    let intent = b.intent(0);
    let entry = svm_tests::standby_pda(&intent, 0);
    let ix = svm_tests::drop_claim_line_ix(
        &solana_signer::Signer::pubkey(&holder),
        &intent,
        &[entry],
        Some(&solana_signer::Signer::pubkey(&waiter)),
    );
    let r = b.ready(ix, vec![holder])?.named("entry", entry);
    revival(Ok(r), &["entry"])
}

#[test]
fn closing_accounts_settle_claims_leaves_no_revivable_account() -> TestResult {
    revival(worlds::settle_claims(), &["board"])
}

#[test]
fn closing_accounts_close_announcement_leaves_no_revivable_account() -> TestResult {
    revival(worlds::close_announcement_ready(), &["announcement"])
}

#[test]
fn closing_accounts_close_delivery_book_leaves_no_revivable_account() -> TestResult {
    revival(worlds::close_delivery_book(), &["book"])
}

#[test]
fn closing_accounts_close_legacy_leaves_no_revivable_account() -> TestResult {
    revival(worlds::close_legacy(), &["legacy"])
}
