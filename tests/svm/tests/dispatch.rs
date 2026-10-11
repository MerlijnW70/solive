use std::error::Error;

use anchor_lang::error::ErrorCode;
use solana_instruction::Instruction;
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;
use svm_tests::svm_with_engine;

const LAMPORTS_FOR_FEES: u64 = 1_000_000_000;

fn rejection_of(data: Vec<u8>) -> Result<TransactionError, Box<dyn Error>> {
    let mut svm = svm_with_engine()?;
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), LAMPORTS_FOR_FEES)
        .map_err(|failed| format!("airdrop rejected: {:?}", failed.err))?;
    let instruction = Instruction {
        program_id: intent_engine::ID,
        accounts: Vec::new(),
        data,
    };
    let message = Message::new(&[instruction], Some(&payer.pubkey()));
    let transaction = Transaction::new(&[&payer], message, svm.latest_blockhash());
    match svm.send_transaction(transaction) {
        Ok(_) => Err("engine accepted an instruction it does not declare".into()),
        Err(failed) => Ok(failed.err),
    }
}

#[test]
fn engine_account_is_deployed_as_executable_at_declared_id() -> Result<(), Box<dyn Error>> {
    let svm = svm_with_engine()?;
    let account = svm
        .get_account(&intent_engine::ID)
        .ok_or("engine account missing")?;
    assert!(account.executable);
    Ok(())
}

#[test]
fn engine_rejects_unknown_discriminator_with_fallback_not_found() -> Result<(), Box<dyn Error>> {
    assert_eq!(
        rejection_of(vec![0; 8])?,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(ErrorCode::InstructionFallbackNotFound.into())
        )
    );
    Ok(())
}

#[test]
fn engine_rejects_data_shorter_than_discriminator_with_fallback_not_found(
) -> Result<(), Box<dyn Error>> {
    assert_eq!(
        rejection_of(vec![0; 7])?,
        TransactionError::InstructionError(
            0,
            InstructionError::Custom(ErrorCode::InstructionFallbackNotFound.into())
        )
    );
    Ok(())
}
