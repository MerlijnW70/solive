use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::errors::EngineError;
use crate::events::CommitteeFloorSet;
use crate::floors::place_floor;
use crate::state::{Config, CONFIG_ADDRESS, CONFIG_VERSION};

#[event_cpi]
#[derive(Accounts)]
pub struct SetCommitteeFloor<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        address = CONFIG_ADDRESS,
        constraint = config.load()?.version == CONFIG_VERSION @ EngineError::AccountOutdated,
        has_one = admin @ EngineError::Unauthorized
    )]
    pub config: AccountLoader<'info, Config>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
}

pub fn handle_set_committee_floor(ctx: Context<SetCommitteeFloor>, floor: u64) -> Result<()> {
    let mint = ctx.accounts.mint.key();
    place_floor(&mut *ctx.accounts.config.load_mut()?, &mint, floor)?;
    emit_cpi!(CommitteeFloorSet { mint, floor });
    Ok(())
}
