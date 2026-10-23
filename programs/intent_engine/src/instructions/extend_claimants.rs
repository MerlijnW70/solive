use anchor_lang::prelude::*;

use crate::errors::EngineError;
use crate::roster::add;
use crate::state::{ClaimList, CLAIM_LIST_SEED, CLAIM_LIST_VERSION};

#[event_cpi]
#[derive(Accounts)]
pub struct ExtendClaimants<'info> {
    pub owner: Signer<'info>,
    /// CHECK: names the list, whose address derives from it
    pub intent: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [CLAIM_LIST_SEED, intent.key().as_ref()],
        bump = claim_list.load()?.bump,
        has_one = owner @ EngineError::Unauthorized,
        constraint = claim_list.load()?.version == CLAIM_LIST_VERSION @ EngineError::AccountOutdated
    )]
    pub claim_list: AccountLoader<'info, ClaimList>,
}

pub fn handle_extend_claimants(ctx: Context<ExtendClaimants>, workers: Vec<Pubkey>) -> Result<()> {
    let listed = {
        let mut list = ctx.accounts.claim_list.load_mut()?;
        require!(list.count < list.size, EngineError::ClaimListSet);
        add(&mut list, &workers)?
    };
    emit_cpi!(listed);
    Ok(())
}
