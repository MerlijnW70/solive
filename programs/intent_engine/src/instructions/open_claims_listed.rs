use anchor_lang::prelude::*;

use crate::errors::EngineError;
use crate::instructions::open_claims::{delivered, fill_board, fund_kill_fee, open_terms, Asked};
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
    /// CHECK: the intent's delivery book, checked by hand against its seeds and read only to learn whether an announcement exists
    pub book: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_open_claims_listed(
    ctx: Context<OpenClaimsListed>,
    max_secs: u32,
    stake: u64,
    size: u8,
    workers: Vec<Pubkey>,
    review_secs: u32,
    kill_fee: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let asked = Asked {
        max_secs,
        stake,
        review_secs,
        kill_fee,
        floor: Rent::get()?.minimum_balance(0),
    };
    let open = open_terms(
        &mut *ctx.accounts.intent.load_mut()?,
        now,
        asked,
        delivered(
            &ctx.accounts.book.to_account_info(),
            &ctx.accounts.intent.key(),
        )?,
    )?;
    fund_kill_fee(
        &ctx.accounts.system_program,
        ctx.accounts.owner.to_account_info(),
        ctx.accounts.board.to_account_info(),
        open.review.kill_fee(),
    )?;
    let (opened, listed) = {
        let mut board = ctx.accounts.board.load_init()?;
        let opened = fill_board(
            &mut board,
            ctx.accounts.intent.key(),
            ctx.accounts.owner.key(),
            &open,
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
