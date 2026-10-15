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
        constraint = intent.load()?.version == INTENT_VERSION @ EngineError::UnsupportedVersion
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

pub fn handle_open_claims(ctx: Context<OpenClaims>, max_secs: u32, stake: u64) -> Result<()> {
    let terms = Terms::new(max_secs, stake).map_err(core_err)?;
    let now = Clock::get()?.unix_timestamp;
    let owner = ctx.accounts.owner.key();
    {
        let mut intent = ctx.accounts.intent.load_mut()?;
        let status = Status::try_from(intent.status).map_err(core_err)?;
        require!(
            status == Status::Open && now < intent.expires_at,
            EngineError::InvalidTransition
        );
        require!(intent.claims != CLAIMS_OPEN, EngineError::ClaimsOpen);
        let decoded = CoreIntent::decode(intent.kind, &intent.params).map_err(core_err)?;
        require!(decoded.spec_hash() != [0u8; 32], EngineError::NotAProof);
        intent.claims = CLAIMS_OPEN;
    }
    {
        let mut board = ctx.accounts.board.load_init()?;
        board.intent = ctx.accounts.intent.key();
        board.owner = owner;
        board.stake = terms.stake();
        board.max_secs = terms.max_secs();
        board.version = CLAIMS_VERSION;
        board.bump = ctx.bumps.board;
    }
    emit_cpi!(ClaimsOpened {
        intent: ctx.accounts.intent.key(),
        owner,
        max_secs: terms.max_secs(),
        stake: terms.stake(),
    });
    Ok(())
}
