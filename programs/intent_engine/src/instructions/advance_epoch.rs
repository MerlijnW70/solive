use anchor_lang::prelude::*;
use intent_core::nonce::epoch_jump_allowed;

use crate::errors::EngineError;
use crate::events::EpochAdvanced;
use crate::state::{UserState, USER_SEED, USER_VERSION};

#[event_cpi]
#[derive(Accounts)]
pub struct AdvanceEpoch<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [USER_SEED, owner.key().as_ref()],
        bump = user_state.load()?.bump,
        constraint = user_state.load()?.version == USER_VERSION @ EngineError::AccountOutdated,
        has_one = owner @ EngineError::Unauthorized
    )]
    pub user_state: AccountLoader<'info, UserState>,
}

pub fn handle_advance_epoch(ctx: Context<AdvanceEpoch>, epoch: u64) -> Result<()> {
    {
        let mut user = ctx.accounts.user_state.load_mut()?;
        require!(epoch > user.epoch, EngineError::EpochRegression);
        require!(
            epoch_jump_allowed(user.epoch, epoch),
            EngineError::EpochJumpTooLarge
        );
        user.epoch = epoch;
    }
    emit_cpi!(EpochAdvanced {
        owner: ctx.accounts.owner.key(),
        epoch,
    });
    Ok(())
}
