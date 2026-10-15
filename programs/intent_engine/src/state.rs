use anchor_lang::prelude::*;
use intent_core::committee::MAX_MEMBERS;
use intent_core::mandate::{Limits, Usage};
use intent_core::PARAMS_LEN;

pub const CONFIG_SEED: &[u8] = b"config";
pub const USER_SEED: &[u8] = b"user";
pub const INTENT_SEED: &[u8] = b"intent";
pub const VAULT_SEED: &[u8] = b"vault";
pub const DELEGATE_SEED: &[u8] = b"delegate";
pub const MANDATE_SEED: &[u8] = b"mandate";
pub const MINT_CAP_SEED: &[u8] = b"mint_cap";
pub const COMMITTEE_SEED: &[u8] = b"committee";

pub const CONFIG_ADDRESS: Pubkey = pubkey!("6As2PgaNQ2DdSZMcrZeUJZ7RfyE2kXnVd33yxbgXULYz");

pub fn delegate_address(owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[DELEGATE_SEED, owner.as_ref()], &crate::ID).0
}

pub const CONFIG_VERSION: u8 = 1;
pub const USER_VERSION: u8 = 1;
pub const INTENT_VERSION: u8 = 1;
pub const MANDATE_VERSION: u8 = 1;
pub const MINT_CAP_VERSION: u8 = 1;
pub const COMMITTEE_VERSION: u8 = 1;
pub const MIN_CAP_WINDOW_SECS: u32 = 60;
pub const OLDEST_CONFIG_VERSION: u8 = 1;
pub const OLDEST_INTENT_VERSION: u8 = 1;

pub fn config_recoverable(version: u8) -> bool {
    (OLDEST_CONFIG_VERSION..=CONFIG_VERSION).contains(&version)
}

pub fn intent_recoverable(version: u8) -> bool {
    (OLDEST_INTENT_VERSION..=INTENT_VERSION).contains(&version)
}
pub const MAX_FEE_BPS: u16 = 100;
pub const MAX_ATTESTED_FEE_BPS: u16 = 300;
pub const BPS: u16 = 10_000;
pub const MAX_CRANK_BOUNTY: u32 = 10_000_000;
pub const MAX_CREATE_FEE: u32 = 10_000_000;

pub const PAUSE_CREATE: u8 = 0b01;
pub const PAUSE_FILL: u8 = 0b10;
pub const PAUSE_ALL: u8 = PAUSE_CREATE | PAUSE_FILL;

#[account(zero_copy)]
pub struct Config {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    pub guardian: Pubkey,
    pub fee_recipient: Pubkey,
    pub enabled_kinds: u64,
    pub fee_bps: u16,
    pub paused: u8,
    pub version: u8,
    pub bump: u8,
    pub kind_fee_mask: u8,
    pub partner_cut_bps: u16,
    pub domain: [u8; 32],
    pub fill_disabled_kinds: u64,
    pub kind_fee_bps: [u16; 4],
    pub crank_bounty: u32,
    pub create_fee: u32,
    pub caps_required: u8,
    pub reserved: [u8; 7],
}

impl Config {
    pub const SPACE: usize = 8 + core::mem::size_of::<Config>();
}

#[account(zero_copy)]
pub struct UserState {
    pub owner: Pubkey,
    pub nonce_base: u64,
    pub nonce_bitmap: [u64; 4],
    pub version: u8,
    pub bump: u8,
    pub padding: [u8; 6],
    pub epoch: u64,
    pub grants: u64,
    pub reserved: [u8; 48],
}

impl UserState {
    pub const SPACE: usize = 8 + core::mem::size_of::<UserState>();
}

#[account(zero_copy)]
pub struct Intent {
    pub owner: Pubkey,
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    pub receiver: Pubkey,
    pub nonce: u64,
    pub escrowed: u64,
    pub created_at: i64,
    pub expires_at: i64,
    pub kind: u8,
    pub status: u8,
    pub bump: u8,
    pub vault_bump: u8,
    pub version: u8,
    pub padding: [u8; 1],
    pub flags: u16,
    pub params: [u8; PARAMS_LEN],
    pub rent_payer: Pubkey,
    pub filled: u64,
    pub revision: u32,
    pub partner_bps: u16,
    pub partner_cut_bps: u16,
    pub in_flight: u64,
    pub partner: Pubkey,
    pub bounty: u32,
    pub mandate: Pubkey,
    pub gap: [u8; 4],
    pub mandate_serial: u64,
    pub agent_fee: u64,
    pub reserved: [u8; 16],
}

impl Intent {
    pub const SPACE: usize = 8 + core::mem::size_of::<Intent>();
}

#[account(zero_copy)]
pub struct Mandate {
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    pub partner: Pubkey,
    pub input_account: Pubkey,
    pub output_account: Pubkey,
    pub id: u64,
    pub epoch: u64,
    pub valid_until: i64,
    pub max_ttl: i64,
    pub per_intent: u64,
    pub total: u64,
    pub spent: u64,
    pub floor_out: u64,
    pub floor_in: u64,
    pub max_intents: u32,
    pub intents: u32,
    pub partner_bps: u16,
    pub kinds: u8,
    pub version: u8,
    pub bump: u8,
    pub padding: [u8; 3],
    pub serial: u64,
    pub agent_fee: u64,
    pub reserved: [u8; 48],
}

impl Mandate {
    pub const SPACE: usize = 8 + core::mem::size_of::<Mandate>();

    pub fn limits(&self) -> Limits {
        Limits {
            kinds: self.kinds,
            per_intent: self.per_intent,
            total: self.total,
            max_intents: self.max_intents,
            max_ttl: self.max_ttl,
            valid_until: self.valid_until,
            floor_out: self.floor_out,
            floor_in: self.floor_in,
            agent_fee: self.agent_fee,
        }
    }

    pub fn usage(&self) -> Usage {
        Usage {
            spent: self.spent,
            intents: self.intents,
        }
    }
}

#[account(zero_copy)]
pub struct MintCap {
    pub mint: Pubkey,
    pub max_per_order: u64,
    pub window_cap: u64,
    pub window_start: i64,
    pub window_used: u64,
    pub window_secs: u32,
    pub version: u8,
    pub bump: u8,
    pub padding: [u8; 2],
    pub reserved: [u8; 56],
}

impl MintCap {
    pub const SPACE: usize = 8 + core::mem::size_of::<MintCap>();
}

#[account(zero_copy)]
pub struct Committee {
    pub members: [Pubkey; MAX_MEMBERS],
    pub fee_wallet: Pubkey,
    pub id: [u8; 32],
    pub created_at: i64,
    pub threshold: u8,
    pub count: u8,
    pub version: u8,
    pub bump: u8,
    pub padding: [u8; 4],
    pub reserved: [u8; 64],
}

impl Committee {
    pub const SPACE: usize = 8 + core::mem::size_of::<Committee>();
}
