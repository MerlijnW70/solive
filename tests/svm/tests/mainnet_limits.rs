use anchor_lang::prelude::Pubkey;
use intent_engine::MAX_SPLIT_RECIPIENTS;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use svm_tests::{cosign_batch_ix, TestResult};

const PACKET_DATA_SIZE: usize = 1_232;
const FILL_FIXED_ACCOUNTS: usize = 8;
const FILL_DATA_BASE: usize = 50;
const FILL_DATA_PER_RECIPIENT: usize = 34;
const BATCH_PER_COSIGNER: usize = 110;
const WIRE_PER_RECIPIENT: usize = 177;

fn fill_shaped(payer: &Pubkey, recipients: usize) -> Instruction {
    let program = intent_engine::ID;
    let mut accounts = vec![AccountMeta::new(*payer, true)];
    for _ in 0..FILL_FIXED_ACCOUNTS.saturating_add(recipients) {
        accounts.push(AccountMeta::new(Pubkey::new_unique(), false));
    }
    accounts.push(AccountMeta::new_readonly(program, false));
    Instruction {
        program_id: program,
        accounts,
        data: vec![
            0u8;
            FILL_DATA_BASE.saturating_add(FILL_DATA_PER_RECIPIENT.saturating_mul(recipients))
        ],
    }
}

fn split_tx_size(recipients: usize) -> TestResult<usize> {
    let signers: Vec<Keypair> = (0..=recipients).map(|_| Keypair::new()).collect();
    let refs: Vec<&Keypair> = signers.iter().collect();
    let batch = cosign_batch_ix(&refs, &[0u8; 32])?;
    let payer = Pubkey::new_unique();
    let fill = fill_shaped(&payer, recipients);
    let message = Message::new(&[batch, fill], Some(&payer));
    let sigs = 64usize
        .saturating_mul(usize::from(message.header.num_required_signatures))
        .saturating_add(1);
    Ok(sigs.saturating_add(message.serialize().len()))
}

fn batch_data_len(cosigners: usize) -> TestResult<usize> {
    let signers: Vec<Keypair> = (0..cosigners).map(|_| Keypair::new()).collect();
    let refs: Vec<&Keypair> = signers.iter().collect();
    Ok(cosign_batch_ix(&refs, &[0u8; 32])?.data.len())
}

#[test]
fn a_split_without_a_lookup_table_fits_two_co_authors_but_not_three() -> TestResult {
    assert!(
        split_tx_size(2)? <= PACKET_DATA_SIZE,
        "two co-authors fit a legacy transaction"
    );
    assert!(
        split_tx_size(3)? > PACKET_DATA_SIZE,
        "three co-authors overflow a legacy transaction"
    );
    Ok(())
}

#[test]
fn the_eight_recipient_cap_overflows_a_legacy_transaction_by_a_wide_margin() -> TestResult {
    assert_eq!(MAX_SPLIT_RECIPIENTS, 8);
    assert!(
        split_tx_size(MAX_SPLIT_RECIPIENTS)? > PACKET_DATA_SIZE,
        "the advertised maximum split cannot ride one legacy transaction"
    );
    let grown = split_tx_size(MAX_SPLIT_RECIPIENTS)?
        .checked_sub(split_tx_size(3)?)
        .ok_or("split wire size shrank as recipients grew")?;
    assert_eq!(
        grown,
        WIRE_PER_RECIPIENT.saturating_mul(MAX_SPLIT_RECIPIENTS.saturating_sub(3)),
        "each co-author past the third adds a fixed run of wire bytes"
    );
    Ok(())
}

#[test]
fn each_extra_co_author_adds_instruction_bytes_a_lookup_table_cannot_shrink() -> TestResult {
    assert_eq!(
        batch_data_len(2)?.checked_sub(batch_data_len(1)?),
        Some(BATCH_PER_COSIGNER),
        "each co-signer adds its own pubkey, signature and offsets to the ed25519 batch"
    );
    let fill = |n: usize| fill_shaped(&Pubkey::new_unique(), n).data.len();
    assert_eq!(
        fill(2).checked_sub(fill(1)),
        Some(FILL_DATA_PER_RECIPIENT),
        "each recipient adds its pubkey and weight to the claim"
    );
    assert_eq!(
        BATCH_PER_COSIGNER.saturating_add(FILL_DATA_PER_RECIPIENT),
        144,
        "a lookup table compresses account keys but never these instruction-data bytes"
    );
    Ok(())
}
