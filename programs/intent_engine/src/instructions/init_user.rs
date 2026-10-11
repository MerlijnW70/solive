use anchor_lang::prelude::*;

use crate::events::UserInitialized;
use crate::state::{UserState, USER_SEED, USER_VERSION};

#[event_cpi]
#[derive(Accounts)]
pub struct InitUser<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = UserState::SPACE,
        seeds = [USER_SEED, owner.key().as_ref()],
        bump
    )]
    pub user_state: AccountLoader<'info, UserState>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_user(ctx: Context<InitUser>) -> Result<()> {
    let owner = ctx.accounts.owner.key();
    {
        let mut user = ctx.accounts.user_state.load_init()?;
        user.owner = owner;
        user.nonce_base = 0;
        user.nonce_bitmap = [0; 4];
        user.version = USER_VERSION;
        user.bump = ctx.bumps.user_state;
    }
    emit_cpi!(UserInitialized { owner });
    Ok(())
}
