use std::panic::{catch_unwind, AssertUnwindSafe};

use anchor_lang::prelude::Pubkey;
use solana_message::AddressLookupTableAccount;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    legacy_size, release_world, unsigned_size, v0_size, wire_size, Form, Release, ReleaseKind,
    Shape, TestResult, PACKET_DATA_SIZE,
};

fn team_split() -> TestResult<Release> {
    release_world(
        anchor_spl::token::ID,
        Shape {
            kind: ReleaseKind::SplitCommittee,
            recipients: 2,
            members: 3,
            threshold: 2,
        },
    )
}

fn panic_text(payload: Box<dyn std::any::Any + Send>) -> String {
    match payload.downcast::<String>() {
        Ok(text) => *text,
        Err(payload) => payload
            .downcast::<&str>()
            .map(|text| (*text).to_owned())
            .unwrap_or_default(),
    }
}

#[test]
fn an_oversize_legacy_release_fails_the_test_naming_its_size_and_instruction() -> TestResult {
    let mut r = team_split()?;
    let payer = r.payer.insecure_clone();
    let ixs = r.ixs.clone();
    let size = legacy_size(&payer.pubkey(), &ixs);
    assert!(size > PACKET_DATA_SIZE, "{size}");
    let escrowed = r.env.balance(&r.vault)?;
    let sent = catch_unwind(AssertUnwindSafe(|| r.env.send(&payer, &ixs, &[])));
    let text = panic_text(
        sent.err()
            .ok_or("an oversize transaction passed Env::send")?,
    );
    assert!(
        text.contains(&format!("a {size}-byte transaction")),
        "{text}"
    );
    assert!(text.contains("fill_attested_split_committee"), "{text}");
    assert_eq!(r.env.balance(&r.vault)?, escrowed, "nothing moved");
    let row = r.measure()?;
    assert_eq!(row.landed.map(|(form, _)| form), Some(Form::Table));
    assert_eq!(
        r.env.balance(&r.vault)?,
        0,
        "the same release lands as v0 with a table"
    );
    Ok(())
}

#[test]
fn the_measured_size_is_the_wire_size_of_the_signed_transaction() -> TestResult {
    let mut r = team_split()?;
    let payer = r.payer.insecure_clone();
    let ixs = r.ixs.clone();
    let table = r.lookup()?;
    let signed = r
        .env
        .v0_transaction(&payer, &ixs, &[], std::slice::from_ref(&table))?;
    assert_eq!(wire_size(&signed), unsigned_size(&signed.message));
    assert_eq!(
        wire_size(&signed),
        v0_size(&payer.pubkey(), &ixs, std::slice::from_ref(&table))?
    );
    assert_eq!(
        usize::try_from(bincode::serialized_size(&signed)?)?,
        wire_size(&signed)
    );
    Ok(())
}

#[test]
fn a_v0_release_resolves_its_accounts_from_the_stored_table_not_the_senders_copy() -> TestResult {
    let mut r = team_split()?;
    let payer = r.payer.insecure_clone();
    let ixs = r.ixs.clone();
    let table = r.lookup()?;
    let missing = AddressLookupTableAccount {
        key: Pubkey::new_unique(),
        addresses: table.addresses.clone(),
    };
    assert_eq!(
        r.env.send_v0(&payer, &ixs, &[], &[missing]).err(),
        Some(TransactionError::AddressLookupTableNotFound)
    );
    let mut shuffled = table.addresses.clone();
    shuffled.reverse();
    let lying = AddressLookupTableAccount {
        key: table.key,
        addresses: shuffled,
    };
    assert!(r.env.send_v0(&payer, &ixs, &[], &[lying]).is_err());
    let escrowed = r.env.balance(&r.vault)?;
    assert!(escrowed > 0);
    r.env.send_v0(&payer, &ixs, &[], &[table])?;
    assert_eq!(r.env.balance(&r.vault)?, 0);
    Ok(())
}

#[test]
fn a_table_that_resolves_no_account_fails_the_test() -> TestResult {
    let mut r = team_split()?;
    let payer = r.payer.insecure_clone();
    let ixs = r.ixs.clone();
    let idle = r
        .env
        .lookup_table(&[Pubkey::new_unique(), Pubkey::new_unique()])?;
    let sent = catch_unwind(AssertUnwindSafe(|| {
        r.env.v0_transaction(&payer, &ixs, &[], &[idle])
    }));
    let text = panic_text(sent.err().ok_or("an idle table passed")?);
    assert!(text.contains("resolve no account"), "{text}");
    Ok(())
}
