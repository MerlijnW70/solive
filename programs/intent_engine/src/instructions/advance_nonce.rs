use anchor_lang::prelude::*;
use intent_core::nonce::{nonce_jump_allowed, Window};

use crate::errors::{core_err, EngineError};
use crate::events::NonceAdvanced;
use crate::state::{UserState, USER_SEED, USER_VERSION};

#[event_cpi]
#[derive(Accounts)]
pub struct AdvanceNonce<'info> {
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

pub fn handle_advance_nonce(ctx: Context<AdvanceNonce>, nonce_base: u64) -> Result<()> {
    {
        let mut user = ctx.accounts.user_state.load_mut()?;
        let mut window = Window {
            base: user.nonce_base,
            bits: user.nonce_bitmap,
        };
        window.advance(nonce_base).map_err(core_err)?;
        require!(
            nonce_jump_allowed(user.nonce_base, nonce_base),
            EngineError::NonceJumpTooLarge
        );
        user.nonce_base = window.base;
        user.nonce_bitmap = window.bits;
    }
    emit_cpi!(NonceAdvanced {
        owner: ctx.accounts.owner.key(),
        nonce_base,
    });
    Ok(())
}
