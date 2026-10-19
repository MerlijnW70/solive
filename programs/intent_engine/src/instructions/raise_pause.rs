use anchor_lang::prelude::*;

use crate::errors::EngineError;
use crate::events::PauseRaised;
use crate::state::{Config, CONFIG_ADDRESS, CONFIG_VERSION, PAUSE_ALL};

#[event_cpi]
#[derive(Accounts)]
pub struct RaisePause<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        address = CONFIG_ADDRESS,
        constraint = config.load()?.version == CONFIG_VERSION @ EngineError::AccountOutdated,
        constraint = {
            let c = config.load()?;
            c.guardian == authority.key() || c.admin == authority.key()
        } @ EngineError::Unauthorized
    )]
    pub config: AccountLoader<'info, Config>,
}

pub fn handle_raise_pause(ctx: Context<RaisePause>, flags: u8) -> Result<()> {
    require!(
        flags != 0 && flags & !PAUSE_ALL == 0,
        EngineError::InvalidPauseFlags
    );
    let paused = {
        let mut config = ctx.accounts.config.load_mut()?;
        config.paused |= flags;
        config.paused
    };
    emit_cpi!(PauseRaised {
        by: ctx.accounts.authority.key(),
        paused,
    });
    Ok(())
}
