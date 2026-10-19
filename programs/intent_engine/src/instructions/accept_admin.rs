use anchor_lang::prelude::*;

use crate::errors::EngineError;
use crate::events::AdminAccepted;
use crate::state::{Config, CONFIG_ADDRESS, CONFIG_VERSION};

#[event_cpi]
#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub pending_admin: Signer<'info>,
    #[account(
        mut,
        address = CONFIG_ADDRESS,
        constraint = config.load()?.version == CONFIG_VERSION @ EngineError::AccountOutdated,
        has_one = pending_admin @ EngineError::NotPendingAdmin
    )]
    pub config: AccountLoader<'info, Config>,
}

pub fn handle_accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let admin = ctx.accounts.pending_admin.key();
    let previous_admin = {
        let mut config = ctx.accounts.config.load_mut()?;
        let previous = config.admin;
        config.admin = admin;
        config.pending_admin = Pubkey::default();
        previous
    };
    emit_cpi!(AdminAccepted {
        previous_admin,
        admin,
    });
    Ok(())
}
