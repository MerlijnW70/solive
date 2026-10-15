use anchor_lang::prelude::*;

pub mod admission;
pub mod caps;
pub mod errors;
pub mod events;
pub mod ext;
pub mod instructions;
pub mod policy;
mod security;
pub mod state;

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
        amount_in: u64,
        result: u64,
        max_fee_bps: u16,
        ext: Ext,
    ) -> Result<()> {
        handle_fill_attested(ctx, amount_in, result, max_fee_bps, ext)
    }

    pub fn fill_attested_split(
        ctx: Context<FillAttestedSplit>,
        amount_in: u64,
        result: u64,
        max_fee_bps: u16,
        claim: SplitClaim,
        ext: Ext,
    ) -> Result<()> {
        handle_fill_attested_split(ctx, amount_in, result, max_fee_bps, claim, ext)
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
    ) -> Result<()> {
        handle_set_mint_cap(ctx, max_per_order, window_cap, window_secs)
    }

    pub fn set_caps_required(ctx: Context<SetCapsRequired>, required: bool) -> Result<()> {
        handle_set_caps_required(ctx, required)
    }
}
