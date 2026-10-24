use anchor_lang::prelude::*;

pub mod admission;
pub mod attested;
pub mod caps;
pub mod claims;
pub mod delivery;
pub mod errors;
pub mod events;
pub mod ext;
pub mod floors;
pub mod instructions;
pub mod policy;
pub mod roster;
mod security;
pub mod state;
pub mod versions;

pub use attested::{Fill, Opening, SplitClaim, MAX_SPLIT_RECIPIENTS};
pub use ext::Ext;
pub use instructions::*;
pub use policy::{ConfigSettings, ConfigUpdate, Economics};

declare_id!("GHFB9q4fhhqRyCoycoivdxMhFkp1aLHJk5VvroUsgrJU");

#[program]
pub mod intent_engine {
    use super::*;

    pub fn init_config(
        ctx: Context<InitConfig>,
        args: ConfigSettings,
        domain: [u8; 32],
    ) -> Result<()> {
        handle_init_config(ctx, args, domain)
    }

    pub fn update_config(ctx: Context<UpdateConfig>, args: ConfigUpdate) -> Result<()> {
        handle_update_config(ctx, args)
    }

    pub fn update_economics(ctx: Context<UpdateEconomics>, args: Economics) -> Result<()> {
        handle_update_economics(ctx, args)
    }

    pub fn propose_admin(ctx: Context<ProposeAdmin>, pending_admin: Pubkey) -> Result<()> {
        handle_propose_admin(ctx, pending_admin)
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        handle_accept_admin(ctx)
    }

    pub fn raise_pause(ctx: Context<RaisePause>, flags: u8) -> Result<()> {
        handle_raise_pause(ctx, flags)
    }

    pub fn lower_pause(ctx: Context<LowerPause>, flags: u8) -> Result<()> {
        handle_lower_pause(ctx, flags)
    }

    pub fn init_user(ctx: Context<InitUser>) -> Result<()> {
        handle_init_user(ctx)
    }

    pub fn advance_nonce(ctx: Context<AdvanceNonce>, nonce_base: u64) -> Result<()> {
        handle_advance_nonce(ctx, nonce_base)
    }

    pub fn advance_epoch(ctx: Context<AdvanceEpoch>, epoch: u64) -> Result<()> {
        handle_advance_epoch(ctx, epoch)
    }

    pub fn create_intent(ctx: Context<CreateIntent>, args: CreateIntentArgs) -> Result<()> {
        handle_create_intent(ctx, args)
    }

    pub fn create_intent_signed(
        ctx: Context<CreateIntentSigned>,
        args: CreateIntentArgs,
        submit_by: i64,
        relayer_fee: u64,
    ) -> Result<()> {
        handle_create_intent_signed(ctx, args, submit_by, relayer_fee)
    }

    pub fn create_mandate(ctx: Context<CreateMandate>, args: MandateArgs) -> Result<()> {
        handle_create_mandate(ctx, args)
    }

    pub fn revoke_mandate(ctx: Context<RevokeMandate>) -> Result<()> {
        handle_revoke_mandate(ctx)
    }

    pub fn create_intent_by_agent(
        ctx: Context<CreateIntentByAgent>,
        args: CreateIntentArgs,
    ) -> Result<()> {
        handle_create_intent_by_agent(ctx, args)
    }

    pub fn fill_attested(
        ctx: Context<FillAttested>,
        fill: Fill,
        opening: Opening,
        ext: Ext,
    ) -> Result<()> {
        handle_fill_attested(ctx, fill, opening, ext)
    }

    pub fn fill_attested_split(
        ctx: Context<FillAttestedSplit>,
        fill: Fill,
        claim: SplitClaim,
        opening: Opening,
        ext: Ext,
    ) -> Result<()> {
        handle_fill_attested_split(ctx, fill, claim, opening, ext)
    }

    pub fn create_committee(
        ctx: Context<CreateCommittee>,
        id: [u8; 32],
        members: Vec<Pubkey>,
        threshold: u8,
        fee_wallet: Pubkey,
    ) -> Result<()> {
        handle_create_committee(ctx, id, members, threshold, fee_wallet)
    }

    pub fn fill_attested_committee(
        ctx: Context<FillAttestedCommittee>,
        fill: Fill,
        signers: u8,
        opening: Opening,
        ext: Ext,
    ) -> Result<()> {
        handle_fill_attested_committee(ctx, fill, signers, opening, ext)
    }

    pub fn fill_attested_split_committee(
        ctx: Context<FillAttestedSplitCommittee>,
        fill: Fill,
        signers: u8,
        claim: SplitClaim,
        opening: Opening,
        ext: Ext,
    ) -> Result<()> {
        handle_fill_attested_split_committee(ctx, fill, signers, claim, opening, ext)
    }

    pub fn open_claims(ctx: Context<OpenClaims>, max_secs: u32, stake: u64) -> Result<()> {
        handle_open_claims(ctx, max_secs, stake)
    }

    pub fn open_claims_listed(
        ctx: Context<OpenClaimsListed>,
        max_secs: u32,
        stake: u64,
        size: u8,
        workers: Vec<Pubkey>,
    ) -> Result<()> {
        handle_open_claims_listed(ctx, max_secs, stake, size, workers)
    }

    pub fn list_claimants(
        ctx: Context<ListClaimants>,
        size: u8,
        workers: Vec<Pubkey>,
    ) -> Result<()> {
        handle_list_claimants(ctx, size, workers)
    }

    pub fn extend_claimants(ctx: Context<ExtendClaimants>, workers: Vec<Pubkey>) -> Result<()> {
        handle_extend_claimants(ctx, workers)
    }

    pub fn claim_job(ctx: Context<ClaimJob>, secs: u32) -> Result<()> {
        handle_claim_job(ctx, secs)
    }

    pub fn drop_claim(ctx: Context<DropClaim>) -> Result<()> {
        handle_drop_claim(ctx)
    }

    pub fn stand_by(ctx: Context<StandBy>, secs: u32) -> Result<()> {
        handle_stand_by(ctx, secs)
    }

    pub fn announce_delivery(
        ctx: Context<AnnounceDelivery>,
        commitment: [u8; 32],
        blob_hash: [u8; 32],
        blob: Vec<u8>,
    ) -> Result<()> {
        handle_announce_delivery(ctx, commitment, blob_hash, blob)
    }

    pub fn advance(ctx: Context<Advance>) -> Result<()> {
        handle_advance(ctx)
    }

    pub fn leave(ctx: Context<Leave>, seq: u32) -> Result<()> {
        handle_leave(ctx, seq)
    }

    pub fn settle_claims(ctx: Context<SettleClaims>) -> Result<()> {
        handle_settle_claims(ctx)
    }

    pub fn create_profile(ctx: Context<CreateProfile>, args: ProfileFields) -> Result<()> {
        handle_create_profile(ctx, args)
    }

    pub fn update_profile(ctx: Context<UpdateProfile>, args: ProfileFields) -> Result<()> {
        handle_update_profile(ctx, args)
    }

    pub fn close_profile(ctx: Context<CloseProfile>) -> Result<()> {
        handle_close_profile(ctx)
    }

    pub fn begin_fill(
        ctx: Context<BeginFill>,
        amount_in: u64,
        end_index: u16,
        max_fee_bps: u16,
        ext: Ext,
    ) -> Result<()> {
        handle_begin_fill(ctx, amount_in, end_index, max_fee_bps, ext)
    }

    pub fn end_fill(ctx: Context<EndFill>, amount_out: u64, ext: Ext) -> Result<()> {
        handle_end_fill(ctx, amount_out, ext)
    }

    pub fn fill_intent(
        ctx: Context<FillIntent>,
        amount_in: u64,
        amount_out: u64,
        max_fee_bps: u16,
        ext: Ext,
    ) -> Result<()> {
        handle_fill_intent(ctx, amount_in, amount_out, max_fee_bps, ext)
    }

    pub fn cancel_intent(ctx: Context<CancelIntent>, ext: Ext) -> Result<()> {
        handle_cancel_intent(ctx, ext)
    }

    pub fn expire_intent(ctx: Context<ExpireIntent>, ext: Ext) -> Result<()> {
        handle_expire_intent(ctx, ext)
    }

    pub fn close_intent(ctx: Context<CloseIntent>, ext: Ext) -> Result<()> {
        handle_close_intent(ctx, ext)
    }

    pub fn set_mint_cap(
        ctx: Context<SetMintCap>,
        max_per_order: u64,
        window_cap: u64,
        window_secs: u32,
        total_limit: u64,
    ) -> Result<()> {
        handle_set_mint_cap(ctx, max_per_order, window_cap, window_secs, total_limit)
    }

    pub fn set_caps_required(ctx: Context<SetCapsRequired>, required: bool) -> Result<()> {
        handle_set_caps_required(ctx, required)
    }

    pub fn set_announce_fee(ctx: Context<SetAnnounceFee>, fee: u32) -> Result<()> {
        handle_set_announce_fee(ctx, fee)
    }

    pub fn sync_committee_keys(ctx: Context<SyncCommitteeKeys>) -> Result<()> {
        handle_sync_committee_keys(ctx)
    }

    pub fn set_committee_floor(ctx: Context<SetCommitteeFloor>, floor: u64) -> Result<()> {
        handle_set_committee_floor(ctx, floor)
    }

    pub fn close_legacy(ctx: Context<CloseLegacy>) -> Result<()> {
        handle_close_legacy(ctx)
    }

    pub fn migrate(ctx: Context<Migrate>) -> Result<()> {
        handle_migrate(ctx)
    }
}
