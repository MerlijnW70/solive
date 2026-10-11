use anchor_lang::prelude::*;

use crate::errors::EngineError;
use crate::events::MandateClosed;
use crate::state::Mandate;

#[event_cpi]
#[derive(Accounts)]
pub struct RevokeMandate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, close = owner, has_one = owner @ EngineError::Unauthorized)]
    pub mandate: AccountLoader<'info, Mandate>,
}

pub fn handle_revoke_mandate(ctx: Context<RevokeMandate>) -> Result<()> {
    let (agent, spent, intents) = {
        let mandate = ctx.accounts.mandate.load()?;
        (mandate.agent, mandate.spent, mandate.intents)
    };
    emit_cpi!(MandateClosed {
        mandate: ctx.accounts.mandate.key(),
        owner: ctx.accounts.owner.key(),
        agent,
        spent,
        intents,
    });
    Ok(())
}
