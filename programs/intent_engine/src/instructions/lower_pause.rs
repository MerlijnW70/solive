use anchor_lang::prelude::*;

use crate::errors::EngineError;
use crate::events::PauseLowered;
use crate::state::{config_recoverable, Config, CONFIG_ADDRESS, PAUSE_ALL};

#[event_cpi]
#[derive(Accounts)]
pub struct LowerPause<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        address = CONFIG_ADDRESS,
        constraint = config_recoverable(config.load()?.version) @ EngineError::UnsupportedVersion,
        has_one = admin @ EngineError::Unauthorized
    )]
    pub config: AccountLoader<'info, Config>,
}

pub fn handle_lower_pause(ctx: Context<LowerPause>, flags: u8) -> Result<()> {
    require!(
        flags != 0 && flags & !PAUSE_ALL == 0,
        EngineError::InvalidPauseFlags
    );
    let paused = {
        let mut config = ctx.accounts.config.load_mut()?;
        config.paused &= !flags;
        config.paused
    };
    emit_cpi!(PauseLowered {
        by: ctx.accounts.admin.key(),
        paused,
    });
    Ok(())
}
