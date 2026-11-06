use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use intent_core::claim::{ReviewTerms, Terms};
use intent_core::kinds::Intent as CoreIntent;
use intent_core::lifecycle::Status;

use crate::delivery::checked_book;
use crate::errors::{core_err, EngineError};
use crate::events::ClaimsOpened;
use crate::state::{ClaimBoard, Intent, CLAIMS_OPEN, CLAIMS_SEED, CLAIMS_VERSION, INTENT_VERSION};

#[event_cpi]
#[derive(Accounts)]
pub struct OpenClaims<'info> {
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
    /// CHECK: the intent's delivery book, checked by hand against its seeds and read only to learn whether an announcement exists
    pub book: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn check_stake(stake: u64, floor: u64) -> Result<()> {
    require!(stake == 0 || stake >= floor, EngineError::StakeBelowRent);
    Ok(())
}

pub fn delivered(book: &AccountInfo, intent: &Pubkey) -> Result<bool> {
    Ok(checked_book(book, intent)?.is_some())
}

pub struct OpenTerms {
    pub terms: Terms,
    pub review: ReviewTerms,
}

#[derive(Clone, Copy)]
pub struct Asked {
    pub max_secs: u32,
    pub stake: u64,
    pub review_secs: u32,
    pub kill_fee: u64,
    pub floor: u64,
}

pub fn open_terms(
    intent: &mut Intent,
    now: i64,
    asked: Asked,
    delivered: bool,
) -> Result<OpenTerms> {
    check_stake(asked.stake, asked.floor)?;
    let terms = Terms::new(asked.max_secs, asked.stake).map_err(core_err)?;
    let status = Status::try_from(intent.status).map_err(core_err)?;
    require!(
        status == Status::Open && now < intent.expires_at,
        EngineError::InvalidTransition
    );
    require!(intent.claims != CLAIMS_OPEN, EngineError::ClaimsOpen);
    let decoded = CoreIntent::decode(intent.kind, &intent.params).map_err(core_err)?;
    require!(decoded.spec_hash() != [0u8; 32], EngineError::NotAProof);
    require!(!delivered, EngineError::ClaimsAfterDelivery);
    let review = ReviewTerms::new(asked.review_secs, asked.kill_fee, asked.stake, asked.floor)
        .map_err(core_err)?;
    intent.claims = CLAIMS_OPEN;
    Ok(OpenTerms { terms, review })
}

pub fn fund_kill_fee<'info>(
    system_program: &Program<'info, System>,
    owner: AccountInfo<'info>,
    board: AccountInfo<'info>,
    kill_fee: u64,
) -> Result<()> {
    if kill_fee == 0 {
        return Ok(());
    }
    transfer(
        CpiContext::new(
            system_program.key(),
            Transfer {
                from: owner,
                to: board,
            },
        ),
        kill_fee,
    )
}

pub fn fill_board(
    board: &mut ClaimBoard,
    intent: Pubkey,
    owner: Pubkey,
    open: &OpenTerms,
    bump: u8,
) -> ClaimsOpened {
    board.intent = intent;
    board.owner = owner;
    board.stake = open.terms.stake();
    board.max_secs = open.terms.max_secs();
    board.version = CLAIMS_VERSION;
    board.bump = bump;
    board.review_secs = open.review.review_secs();
    board.kill_fee = open.review.kill_fee();
    ClaimsOpened {
        intent,
        owner,
        max_secs: open.terms.max_secs(),
        stake: open.terms.stake(),
        review_secs: open.review.review_secs(),
        kill_fee: open.review.kill_fee(),
    }
}

pub fn handle_open_claims(
    ctx: Context<OpenClaims>,
    max_secs: u32,
    stake: u64,
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
    let opened = fill_board(
        &mut *ctx.accounts.board.load_init()?,
        ctx.accounts.intent.key(),
        ctx.accounts.owner.key(),
        &open,
        ctx.bumps.board,
    );
    emit_cpi!(opened);
    Ok(())
}
