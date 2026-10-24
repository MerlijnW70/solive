use anchor_lang::prelude::*;

use crate::errors::EngineError;
use crate::events::AnnounceFeeSet;
use crate::state::{Config, CONFIG_ADDRESS, CONFIG_VERSION, MAX_CREATE_FEE};

#[event_cpi]
#[derive(Accounts)]
pub struct SetAnnounceFee<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        address = CONFIG_ADDRESS,
        constraint = config.load()?.version == CONFIG_VERSION @ EngineError::AccountOutdated,
        has_one = admin @ EngineError::Unauthorized
    )]
    pub config: AccountLoader<'info, Config>,
}

pub fn handle_set_announce_fee(ctx: Context<SetAnnounceFee>, fee: u32) -> Result<()> {
    require!(fee <= MAX_CREATE_FEE, EngineError::CreateFeeTooHigh);
    ctx.accounts.config.load_mut()?.announce_fee = fee;
    emit_cpi!(AnnounceFeeSet { fee });
    Ok(())
}
