use std::panic::{catch_unwind, AssertUnwindSafe};

use anchor_lang::prelude::Pubkey;
use solana_address_lookup_table_interface::instruction::deactivate_lookup_table;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_message::AddressLookupTableAccount;
use solana_signer::Signer;
use solana_slot_hashes::SlotHashes;
use solana_transaction_error::TransactionError;
use svm_tests::{
    ed25519_ix, legacy_size, release_world, unsigned_size, v0_size, wire_size, Env, Form, Release,
    ReleaseKind, Shape, TestResult, PACKET_DATA_SIZE,
};

fn team_split() -> TestResult<Release> {
    release_world(
        anchor_spl::token::ID,
        Shape::new(ReleaseKind::SplitCommittee, 2, 3, 2),
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

#[test]
fn a_deactivated_table_resolves_nothing_once_its_slot_ages_out() -> TestResult {
    let mut r = team_split()?;
    let payer = r.payer.insecure_clone();
    let ixs = r.ixs.clone();
    let authority = Keypair::new();
    let accounts = r.table.clone();
    let table = r.env.lookup_table_by(&authority, &accounts)?;
    r.env.send(
        &authority,
        &[deactivate_lookup_table(table.key, authority.pubkey())],
        &[],
    )?;
    let slot = r.env.svm.get_sysvar::<anchor_lang::prelude::Clock>().slot;
    let next = slot.saturating_add(1);
    r.env.svm.warp_to_slot(next);
    let hash = r.env.svm.latest_blockhash();
    r.env.svm.set_sysvar(&SlotHashes::new(&[(next, hash)]));
    let escrowed = r.env.balance(&r.vault)?;
    assert_eq!(
        r.env.send_v0(&payer, &ixs, &[], &[table]).err(),
        Some(TransactionError::AddressLookupTableNotFound)
    );
    assert_eq!(r.env.balance(&r.vault)?, escrowed, "nothing moved");
    let fresh = r.lookup()?;
    r.env.send_v0(&payer, &ixs, &[], &[fresh])?;
    assert_eq!(r.env.balance(&r.vault)?, 0);
    Ok(())
}

const PROBE: usize = 900;

fn sized(payer: &Keypair, bytes: usize, v0: bool) -> TestResult<Instruction> {
    let size = |ix: &Instruction| -> TestResult<usize> {
        let ixs = std::slice::from_ref(ix);
        if v0 {
            v0_size(&payer.pubkey(), ixs, &[])
        } else {
            Ok(legacy_size(&payer.pubkey(), ixs))
        }
    };
    let base = size(&ed25519_ix(payer, &vec![7; PROBE]))?;
    let length = PROBE
        .checked_add(bytes)
        .and_then(|n| n.checked_sub(base))
        .ok_or("no message length gives that size")?;
    let ix = ed25519_ix(payer, &vec![7; length]);
    assert_eq!(size(&ix)?, bytes);
    Ok(ix)
}

#[test]
fn a_1232_byte_transaction_lands_and_a_1233_byte_one_fails_the_test_legacy_or_v0() -> TestResult {
    let mut env = Env::new()?;
    let payer = env.funded()?;
    let over = sized(&payer, 1_233, false)?;
    let sent = catch_unwind(AssertUnwindSafe(|| env.send(&payer, &[over], &[])));
    let text = panic_text(
        sent.err()
            .ok_or("a 1233-byte transaction passed Env::send")?,
    );
    assert!(
        text.contains(&format!(
            "a 1233-byte transaction is over the {PACKET_DATA_SIZE}-byte packet limit"
        )),
        "{text}"
    );
    env.send(&payer, &[sized(&payer, 1_232, false)?], &[])?;
    let over = sized(&payer, 1_233, true)?;
    let sent = catch_unwind(AssertUnwindSafe(|| env.send_v0(&payer, &[over], &[], &[])));
    assert!(sent.is_err(), "a 1233-byte v0 transaction passed send_v0");
    let at = sized(&payer, 1_232, true)?;
    assert_eq!(
        wire_size(&env.v0_transaction(&payer, std::slice::from_ref(&at), &[], &[])?),
        1_232
    );
    env.send_v0(&payer, &[at], &[], &[])?;
    Ok(())
}
