use anchor_lang::prelude::*;

use crate::errors::EngineError;
use crate::events::EconomicsUpdated;
use crate::policy::{validate_economics, Economics};
use crate::state::{Config, CONFIG_ADDRESS, CONFIG_VERSION};

#[event_cpi]
#[derive(Accounts)]
pub struct UpdateEconomics<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        address = CONFIG_ADDRESS,
        constraint = config.load()?.version == CONFIG_VERSION @ EngineError::UnsupportedVersion,
        has_one = admin @ EngineError::Unauthorized
    )]
    pub config: AccountLoader<'info, Config>,
}

pub fn handle_update_economics(ctx: Context<UpdateEconomics>, args: Economics) -> Result<()> {
    validate_economics(&args)?;
    {
        let mut config = ctx.accounts.config.load_mut()?;
        config.kind_fee_mask = args.kind_fee_mask;
        config.kind_fee_bps = args.kind_fee_bps;
        config.partner_cut_bps = args.partner_cut_bps;
        config.crank_bounty = args.crank_bounty;
        config.create_fee = args.create_fee;
    }
    emit_cpi!(EconomicsUpdated {
        kind_fee_mask: args.kind_fee_mask,
        kind_fee_bps: args.kind_fee_bps,
        partner_cut_bps: args.partner_cut_bps,
        crank_bounty: args.crank_bounty,
        create_fee: args.create_fee,
    });
    Ok(())
}
