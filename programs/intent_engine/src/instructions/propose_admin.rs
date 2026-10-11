use anchor_lang::prelude::*;

use crate::errors::EngineError;
use crate::events::AdminProposed;
use crate::state::{Config, CONFIG_ADDRESS, CONFIG_VERSION};

#[event_cpi]
#[derive(Accounts)]
pub struct ProposeAdmin<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        address = CONFIG_ADDRESS,
        constraint = config.load()?.version == CONFIG_VERSION @ EngineError::UnsupportedVersion,
        has_one = admin @ EngineError::Unauthorized
    )]
    pub config: AccountLoader<'info, Config>,
}

pub fn handle_propose_admin(ctx: Context<ProposeAdmin>, pending_admin: Pubkey) -> Result<()> {
    ctx.accounts.config.load_mut()?.pending_admin = pending_admin;
    emit_cpi!(AdminProposed {
        admin: ctx.accounts.admin.key(),
        pending_admin,
    });
    Ok(())
}
