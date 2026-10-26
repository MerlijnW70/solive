use std::error::Error;
use std::path::PathBuf;

use anchor_lang::prelude::{Clock, Pubkey};
use anchor_lang::solana_program::bpf_loader_upgradeable;
use anchor_lang::{InstructionData, ToAccountMetas};
use anchor_spl::token_2022::spl_token_2022::extension::{
    cpi_guard, default_account_state, interest_bearing_mint, memo_transfer, metadata_pointer,
    pausable, scaled_ui_amount, transfer_fee, transfer_hook, BaseStateWithExtensions,
    ExtensionType, StateWithExtensions,
};
use anchor_spl::token_2022::spl_token_2022::instruction as token_ix;
use anchor_spl::token_2022::spl_token_2022::state::{
    Account as TokenState, AccountState, Mint as MintState,
};
use intent_engine::state::{
    CLAIMS_SEED, CLAIM_LIST_SEED, COMMITTEE_SEED, CONFIG_SEED, DELEGATE_SEED, INTENT_SEED,
    MANDATE_SEED, STANDBY_SEED, USER_SEED, VAULT_SEED,
};
use intent_engine::{ConfigSettings, ConfigUpdate};
use litesvm::types::TransactionMetadata;
use litesvm::LiteSVM;
use solana_instruction::Instruction;
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;

pub type TestResult<T = ()> = Result<T, Box<dyn Error>>;

mod addresses;
mod announcements;
mod claim_world;
mod claims;
mod committee;
mod cu;
mod devnet;
mod errors;
mod fills;
mod intents;
mod legacy;
mod mandate_kit;
mod mandates;
mod payouts;
mod releases;
mod setup;
mod sig;

pub use addresses::*;
pub use announcements::*;
pub use claim_world::*;
pub use claims::*;
pub use committee::*;
pub use cu::*;
pub use devnet::*;
pub use errors::*;
pub use fills::*;
pub use intents::*;
pub use legacy::*;
pub use mandate_kit::*;
pub use mandates::*;
pub use payouts::*;
pub use releases::*;
pub use setup::*;
pub use sig::*;
