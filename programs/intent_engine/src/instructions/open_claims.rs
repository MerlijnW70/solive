use anchor_lang::prelude::*;
use intent_core::claim::Terms;
use intent_core::kinds::Intent as CoreIntent;
use intent_core::lifecycle::Status;

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
    pub system_program: Program<'info, System>,
}

pub fn check_stake(stake: u64, floor: u64) -> Result<()> {
    require!(stake == 0 || stake >= floor, EngineError::StakeBelowRent);
    Ok(())
}

pub fn open_terms(intent: &mut Intent, now: i64, max_secs: u32, stake: u64) -> Result<Terms> {
    let terms = Terms::new(max_secs, stake).map_err(core_err)?;
    let status = Status::try_from(intent.status).map_err(core_err)?;
    require!(
        status == Status::Open && now < intent.expires_at,
        EngineError::InvalidTransition
    );
    require!(intent.claims != CLAIMS_OPEN, EngineError::ClaimsOpen);
    let decoded = CoreIntent::decode(intent.kind, &intent.params).map_err(core_err)?;
    require!(decoded.spec_hash() != [0u8; 32], EngineError::NotAProof);
    intent.claims = CLAIMS_OPEN;
    Ok(terms)
}

pub fn fill_board(
    board: &mut ClaimBoard,
    intent: Pubkey,
    owner: Pubkey,
    terms: Terms,
    bump: u8,
) -> ClaimsOpened {
    board.intent = intent;
    board.owner = owner;
    board.stake = terms.stake();
    board.max_secs = terms.max_secs();
    board.version = CLAIMS_VERSION;
    board.bump = bump;
    ClaimsOpened {
        intent,
        owner,
        max_secs: terms.max_secs(),
        stake: terms.stake(),
    }
}

pub fn handle_open_claims(ctx: Context<OpenClaims>, max_secs: u32, stake: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    check_stake(stake, Rent::get()?.minimum_balance(0))?;
    let terms = open_terms(&mut *ctx.accounts.intent.load_mut()?, now, max_secs, stake)?;
    let opened = fill_board(
        &mut *ctx.accounts.board.load_init()?,
        ctx.accounts.intent.key(),
        ctx.accounts.owner.key(),
        terms,
        ctx.bumps.board,
    );
    emit_cpi!(opened);
    Ok(())
}
