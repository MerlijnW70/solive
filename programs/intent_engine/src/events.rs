use anchor_lang::prelude::*;

#[event]
pub struct ConfigInitialized {
    pub admin: Pubkey,
    pub domain: [u8; 32],
    pub guardian: Pubkey,
    pub fee_recipient: Pubkey,
    pub enabled_kinds: u64,
    pub fee_bps: u16,
    pub paused: u8,
}

#[event]
pub struct ConfigUpdated {
    pub guardian: Pubkey,
    pub fee_recipient: Pubkey,
    pub enabled_kinds: u64,
    pub fee_bps: u16,
    pub paused: u8,
    pub fill_disabled_kinds: u64,
}

#[event]
pub struct EconomicsUpdated {
    pub kind_fee_mask: u8,
    pub kind_fee_bps: [u16; 4],
    pub partner_cut_bps: u16,
    pub crank_bounty: u32,
    pub create_fee: u32,
}

#[event]
pub struct AdminProposed {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
}

#[event]
pub struct AdminAccepted {
    pub previous_admin: Pubkey,
    pub admin: Pubkey,
}

#[event]
pub struct PauseRaised {
    pub by: Pubkey,
    pub paused: u8,
}

#[event]
pub struct PauseLowered {
    pub by: Pubkey,
    pub paused: u8,
}

#[event]
pub struct UserInitialized {
    pub owner: Pubkey,
}

#[event]
pub struct NonceAdvanced {
    pub owner: Pubkey,
    pub nonce_base: u64,
}

#[event]
pub struct EpochAdvanced {
    pub owner: Pubkey,
    pub epoch: u64,
}

#[event]
pub struct IntentCreated {
    pub intent: Pubkey,
    pub owner: Pubkey,
    pub nonce: u64,
    pub kind: u8,
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    pub receiver: Pubkey,
    pub escrowed: u64,
    pub expires_at: i64,
    pub rent_payer: Pubkey,
    pub flags: u16,
    pub bounty: u32,
    pub create_fee: u32,
}

#[event]
pub struct IntentFilled {
    pub intent: Pubkey,
    pub owner: Pubkey,
    pub solver: Pubkey,
    pub receiver: Pubkey,
    pub solver_input: Pubkey,
    pub amount_in: u64,
    pub delivered: u64,
    pub required: u64,
    pub fee: u64,
    pub net: u64,
    pub filled: u64,
    pub remaining: u64,
    pub partner_fee: u64,
}

#[event]
pub struct IntentAttested {
    pub intent: Pubkey,
    pub owner: Pubkey,
    pub solver: Pubkey,
    pub payee: Pubkey,
    pub attestor: Pubkey,
    pub amount_in: u64,
    pub result: u64,
    pub fee: u64,
    pub net: u64,
    pub filled: u64,
    pub remaining: u64,
    pub partner_fee: u64,
}

#[event]
pub struct FillBegun {
    pub intent: Pubkey,
    pub solver: Pubkey,
    pub solver_input: Pubkey,
    pub end_index: u16,
    pub amount_in: u64,
    pub fee: u64,
    pub net: u64,
    pub filled: u64,
    pub remaining: u64,
    pub partner_fee: u64,
}

#[event]
pub struct FillEnded {
    pub intent: Pubkey,
    pub owner: Pubkey,
    pub solver: Pubkey,
    pub receiver: Pubkey,
    pub delivered: u64,
    pub required: u64,
}

#[event]
pub struct IntentCancelled {
    pub intent: Pubkey,
    pub owner: Pubkey,
    pub refunded: u64,
}

#[event]
pub struct IntentExpired {
    pub intent: Pubkey,
    pub owner: Pubkey,
    pub refunded: u64,
    pub refund_to: Pubkey,
    pub by: Pubkey,
    pub bounty: u32,
}

#[event]
pub struct IntentClosed {
    pub intent: Pubkey,
    pub owner: Pubkey,
    pub swept: u64,
    pub refund_to: Pubkey,
    pub by: Pubkey,
    pub bounty: u32,
    pub bounty_to: Pubkey,
    pub rent_to: Pubkey,
}

#[event]
pub struct MandateCreated {
    pub mandate: Pubkey,
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub id: u64,
    pub serial: u64,
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    pub input_account: Pubkey,
    pub output_account: Pubkey,
    pub kinds: u8,
    pub per_intent: u64,
    pub total: u64,
    pub max_intents: u32,
    pub max_ttl: i64,
    pub valid_until: i64,
    pub floor_out: u64,
    pub floor_in: u64,
    pub partner: Pubkey,
    pub partner_bps: u16,
    pub epoch: u64,
    pub agent_fee: u64,
}

#[event]
pub struct MandateUsed {
    pub mandate: Pubkey,
    pub intent: Pubkey,
    pub agent: Pubkey,
    pub escrowed: u64,
    pub agent_fee: u64,
    pub spent: u64,
    pub intents: u32,
}

#[event]
pub struct AgentPaid {
    pub intent: Pubkey,
    pub agent: Pubkey,
    pub account: Pubkey,
    pub fee: u64,
}

pub const WITHHELD_PARTNER: u8 = 1;
pub const WITHHELD_AGENT: u8 = 2;
pub const WITHHELD_TREASURY: u8 = 3;
pub const WITHHELD_JUDGE: u8 = 4;

#[event]
pub struct FeeWithheld {
    pub intent: Pubkey,
    pub payee: Pubkey,
    pub account: Pubkey,
    pub fee: u64,
    pub role: u8,
}

#[event]
pub struct RelayerPaid {
    pub intent: Pubkey,
    pub relayer: Pubkey,
    pub account: Pubkey,
    pub fee: u64,
}

#[event]
pub struct MandateClosed {
    pub mandate: Pubkey,
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub spent: u64,
    pub intents: u32,
}

#[event]
pub struct IntentSplit {
    pub intent: Pubkey,
    pub owner: Pubkey,
    pub solver: Pubkey,
    pub attestor: Pubkey,
    pub amount_in: u64,
    pub result: u64,
    pub fee: u64,
    pub net: u64,
    pub partner_fee: u64,
    pub recipients: u8,
    pub split_hash: [u8; 32],
}

#[event]
pub struct MintCapSet {
    pub mint: Pubkey,
    pub mint_cap: Pubkey,
    pub max_per_order: u64,
    pub window_cap: u64,
    pub window_secs: u32,
    pub window_start: i64,
    pub window_used: u64,
    pub total_limit: u64,
    pub outstanding: u64,
}

#[event]
pub struct CapsRequiredSet {
    pub required: bool,
}

#[event]
pub struct CommitteeFloorSet {
    pub mint: Pubkey,
    pub floor: u64,
}

#[event]
pub struct CommitteeCreated {
    pub committee: Pubkey,
    pub members: Vec<Pubkey>,
    pub threshold: u8,
    pub fee_wallet: Pubkey,
}

#[event]
pub struct CommitteeAttested {
    pub intent: Pubkey,
    pub committee: Pubkey,
    pub signers: Vec<Pubkey>,
}

pub const STAKE_TO_WORKER: u8 = 0;
pub const STAKE_TO_OWNER: u8 = 1;

#[event]
pub struct ClaimsOpened {
    pub intent: Pubkey,
    pub owner: Pubkey,
    pub max_secs: u32,
    pub stake: u64,
}

#[event]
pub struct JobClaimed {
    pub intent: Pubkey,
    pub worker: Pubkey,
    pub until: i64,
    pub stake: u64,
}

#[event]
pub struct ClaimDropped {
    pub intent: Pubkey,
    pub worker: Pubkey,
    pub refunded: u64,
}

#[event]
pub struct StakeMoved {
    pub intent: Pubkey,
    pub worker: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
    pub role: u8,
}

#[event]
pub struct StoodBy {
    pub intent: Pubkey,
    pub worker: Pubkey,
    pub seq: u32,
    pub secs: u32,
    pub stake: u64,
}

#[event]
pub struct LineLeft {
    pub intent: Pubkey,
    pub worker: Pubkey,
    pub seq: u32,
    pub refunded: u64,
}

#[event]
pub struct ClaimsClosed {
    pub intent: Pubkey,
    pub owner: Pubkey,
}

#[event]
pub struct ClaimantsListed {
    pub intent: Pubkey,
    pub owner: Pubkey,
    pub size: u8,
    pub count: u8,
    pub workers: Vec<Pubkey>,
}

#[event]
pub struct ProfileSet {
    pub wallet: Pubkey,
    pub skills: Vec<String>,
    pub endpoint: String,
    pub doc_url: String,
    pub doc_hash: [u8; 32],
    pub encryption_key: [u8; 32],
}

#[event]
pub struct ProfileClosed {
    pub wallet: Pubkey,
}

#[event]
pub struct LegacyClosed {
    pub account: Pubkey,
    pub payee: Pubkey,
    pub lamports: u64,
    pub stake: u64,
}

#[event]
pub struct AccountMigrated {
    pub account: Pubkey,
    pub from_version: u8,
    pub version: u8,
    pub from_space: u32,
    pub space: u32,
    pub top_up: u64,
    pub fee_bps: u16,
    pub fee_dropped: bool,
}

#[event]
pub struct DeliveryAnnounced {
    pub intent: Pubkey,
    pub announcement: Pubkey,
    pub seq: u64,
    pub worker: Pubkey,
    pub payer: Pubkey,
    pub attestor: Pubkey,
    pub commitment: [u8; 32],
    pub slot: u64,
    pub recipients: u8,
}

#[event]
pub struct AnnounceFeeSet {
    pub fee: u32,
}

#[event]
pub struct CommitteeKeysSynced {
    pub committee: Pubkey,
    pub mask: u8,
    pub fingerprints: [[u8; 8]; 8],
}

#[event]
pub struct DeliveryReleased {
    pub intent: Pubkey,
    pub announcement: Pubkey,
    pub seq: u64,
    pub worker: Pubkey,
    pub attestor: Pubkey,
    pub delivered: [u8; 32],
    pub salt: [u8; 16],
    pub split_hash: [u8; 32],
}
