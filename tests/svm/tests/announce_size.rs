use std::str::FromStr;

use anchor_lang::prelude::Pubkey;
use intent_core::delivery::{MAX_BLOB_RECIPIENTS, MAX_BLOB_URL, MAX_SEALED_BLOB};
use solana_instruction::Instruction;
use solana_message::Message;
use svm_tests::{test_blob, Announce, TestResult};

const PACKET_DATA_SIZE: usize = 1_232;

fn compute_budget() -> TestResult<[Instruction; 2]> {
    let program = Pubkey::from_str("ComputeBudget111111111111111111111111111111")
        .map_err(|e| format!("{e:?}"))?;
    let mut limit = vec![2u8];
    limit.extend_from_slice(&200_000u32.to_le_bytes());
    let mut price = vec![3u8];
    price.extend_from_slice(&1_000u64.to_le_bytes());
    Ok([
        Instruction {
            program_id: program,
            accounts: vec![],
            data: limit,
        },
        Instruction {
            program_id: program,
            accounts: vec![],
            data: price,
        },
    ])
}

fn wire_size(a: &Announce) -> TestResult<usize> {
    let [limit, price] = compute_budget()?;
    let message = Message::new(&[limit, price, a.ix()], Some(&a.payer));
    let signatures = 64usize
        .saturating_mul(usize::from(message.header.num_required_signatures))
        .saturating_add(1);
    Ok(signatures.saturating_add(message.serialize().len()))
}

fn shaped(committee: bool, heavy: bool, url: usize) -> Announce {
    let recipients = if committee { MAX_BLOB_RECIPIENTS } else { 1 };
    let fps = vec![[1u8; 8]; recipients];
    let mask = if committee { 0xff } else { 1 };
    let worker = Pubkey::new_unique();
    let a = Announce {
        profile: !committee,
        committee,
        ..Announce::new(
            worker,
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            test_blob(mask, &fps, url, 2),
        )
    };
    if heavy {
        Announce {
            payer: Pubkey::new_unique(),
            board: Some(Pubkey::new_unique()),
            claim_list: Some(Pubkey::new_unique()),
            fee_to: Some(Pubkey::new_unique()),
            ..a
        }
    } else {
        a
    }
}

fn longest_url(committee: bool, heavy: bool) -> TestResult<usize> {
    let mut best = 0;
    for url in 1..=MAX_BLOB_URL {
        if wire_size(&shaped(committee, heavy, url))? <= PACKET_DATA_SIZE {
            best = url;
        }
    }
    Ok(best)
}

#[test]
fn a_worker_announces_the_longest_url_to_any_judge_or_committee() -> TestResult {
    for committee in [false, true] {
        let a = shaped(committee, false, MAX_BLOB_URL);
        assert!(a.blob.len() <= MAX_SEALED_BLOB);
        let size = wire_size(&a)?;
        assert!(
            size <= PACKET_DATA_SIZE,
            "committee {committee}: {size} bytes"
        );
    }
    assert_eq!(longest_url(false, true)?, MAX_BLOB_URL);
    Ok(())
}

#[test]
fn a_relayed_committee_announcement_with_claims_and_a_fee_needs_a_shorter_url() -> TestResult {
    let longest = longest_url(true, true)?;
    assert_eq!(longest, 116);
    assert!(wire_size(&shaped(true, true, longest))? <= PACKET_DATA_SIZE);
    assert!(wire_size(&shaped(true, true, longest + 1))? > PACKET_DATA_SIZE);
    Ok(())
}
