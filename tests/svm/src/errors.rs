use super::*;

pub fn engine_error(e: intent_engine::errors::EngineError) -> TransactionError {
    TransactionError::InstructionError(0, InstructionError::Custom(u32::from(e)))
}

pub fn anchor_error(e: anchor_lang::error::ErrorCode) -> TransactionError {
    TransactionError::InstructionError(0, InstructionError::Custom(u32::from(e)))
}

pub fn anchor_error_at(index: u8, e: anchor_lang::error::ErrorCode) -> TransactionError {
    TransactionError::InstructionError(index, InstructionError::Custom(u32::from(e)))
}

pub fn engine_error_at(index: u8, e: intent_engine::errors::EngineError) -> TransactionError {
    TransactionError::InstructionError(index, InstructionError::Custom(u32::from(e)))
}
