use anchor_lang::prelude::*;
use intent_core::lifecycle::Status;

use crate::errors::{core_err, EngineError};
use crate::roster::{check_unclaimed, start};
use crate::state::{
    ClaimBoard, ClaimList, Intent, CLAIMS_OPEN, CLAIMS_SEED, CLAIMS_VERSION, CLAIM_LIST_SEED,
    INTENT_VERSION,
};

#[event_cpi]
#[derive(Accounts)]
pub struct ListClaimants<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        has_one = owner @ EngineError::Unauthorized,
        constraint = intent.load()?.version == INTENT_VERSION @ EngineError::AccountOutdated
    )]
    pub intent: AccountLoader<'info, Intent>,
    #[account(
        mut,
        seeds = [CLAIMS_SEED, intent.key().as_ref()],
        bump = board.load()?.bump,
        has_one = owner @ EngineError::Unauthorized,
        constraint = board.load()?.version == CLAIMS_VERSION @ EngineError::AccountOutdated
    )]
    pub board: AccountLoader<'info, ClaimBoard>,
    #[account(
        init,
        payer = owner,
        space = ClaimList::SPACE,
        seeds = [CLAIM_LIST_SEED, intent.key().as_ref()],
        bump
    )]
    pub claim_list: AccountLoader<'info, ClaimList>,
    pub system_program: Program<'info, System>,
}

pub fn handle_list_claimants(
    ctx: Context<ListClaimants>,
    size: u8,
    workers: Vec<Pubkey>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    {
        let intent = ctx.accounts.intent.load()?;
        let status = Status::try_from(intent.status).map_err(core_err)?;
        require!(
            status == Status::Open && now < intent.expires_at,
            EngineError::InvalidTransition
        );
        require!(intent.claims == CLAIMS_OPEN, EngineError::ClaimsMissing);
    }
    let listed = {
        let mut board = ctx.accounts.board.load_mut()?;
        check_unclaimed(&board, now)?;
        start(
            &mut *ctx.accounts.claim_list.load_init()?,
            &mut board,
            ctx.bumps.claim_list,
            size,
            &workers,
        )?
    };
    emit_cpi!(listed);
    Ok(())
}
