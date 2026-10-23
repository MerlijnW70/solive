use anchor_lang::prelude::*;

use crate::errors::EngineError;
use crate::instructions::open_claims::{fill_board, open_terms};
use crate::roster::start;
use crate::state::{ClaimBoard, ClaimList, Intent, CLAIMS_SEED, CLAIM_LIST_SEED, INTENT_VERSION};

#[event_cpi]
#[derive(Accounts)]
pub struct OpenClaimsListed<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        has_one = owner @ EngineError::Unauthorized,
        constraint = intent.load()?.version == INTENT_VERSION @ EngineError::AccountOutdated
    )]
    pub intent: AccountLoader<'info, Intent>,
    #[account(
        init,
        payer = owner,
        space = ClaimBoard::SPACE,
        seeds = [CLAIMS_SEED, intent.key().as_ref()],
        bump
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

pub fn handle_open_claims_listed(
    ctx: Context<OpenClaimsListed>,
    max_secs: u32,
    stake: u64,
    size: u8,
    workers: Vec<Pubkey>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let terms = open_terms(&mut *ctx.accounts.intent.load_mut()?, now, max_secs, stake)?;
    let (opened, listed) = {
        let mut board = ctx.accounts.board.load_init()?;
        let opened = fill_board(
            &mut board,
            ctx.accounts.intent.key(),
            ctx.accounts.owner.key(),
            terms,
            ctx.bumps.board,
        );
        let listed = start(
            &mut *ctx.accounts.claim_list.load_init()?,
            &mut board,
            ctx.bumps.claim_list,
            size,
            &workers,
        )?;
        (opened, listed)
    };
    emit_cpi!(opened);
    emit_cpi!(listed);
    Ok(())
}
