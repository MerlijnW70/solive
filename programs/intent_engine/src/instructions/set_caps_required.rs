use anchor_lang::prelude::*;

use crate::errors::EngineError;
use crate::events::CapsRequiredSet;
use crate::state::{Config, CONFIG_ADDRESS, CONFIG_VERSION};

#[event_cpi]
#[derive(Accounts)]
pub struct SetCapsRequired<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        address = CONFIG_ADDRESS,
        constraint = config.load()?.version == CONFIG_VERSION @ EngineError::UnsupportedVersion,
        has_one = admin @ EngineError::Unauthorized
    )]
    pub config: AccountLoader<'info, Config>,
}

pub fn handle_set_caps_required(ctx: Context<SetCapsRequired>, required: bool) -> Result<()> {
    ctx.accounts.config.load_mut()?.caps_required = u8::from(required);
    emit_cpi!(CapsRequiredSet { required });
    Ok(())
}
