use anchor_lang::prelude::*;
use intent_core::claim::Slot;

use crate::claims::{move_lamports, slot_of};
use crate::errors::EngineError;
use crate::events::ClaimDropped;
use crate::state::{ClaimBoard, CLAIMS_SEED, CLAIMS_VERSION};

#[event_cpi]
#[derive(Accounts)]
pub struct DropClaim<'info> {
    #[account(mut)]
    pub worker: Signer<'info>,
    /// CHECK: only names the board, whose address derives from it
    pub intent: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [CLAIMS_SEED, intent.key().as_ref()],
        bump = board.load()?.bump,
        constraint = board.load()?.version == CLAIMS_VERSION @ EngineError::UnsupportedVersion
    )]
    pub board: AccountLoader<'info, ClaimBoard>,
}

pub fn handle_drop_claim(ctx: Context<DropClaim>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let worker = ctx.accounts.worker.key();
    let (intent, held) = {
        let board = ctx.accounts.board.load()?;
        match slot_of(&board, now) {
            Slot::Held { worker: holder, .. } if holder == worker.to_bytes() => {}
            _ => return err!(EngineError::NotClaimant),
        }
        (board.intent, board.held)
    };
    move_lamports(
        &ctx.accounts.board.to_account_info(),
        &ctx.accounts.worker.to_account_info(),
        held,
    )?;
    {
        let mut board = ctx.accounts.board.load_mut()?;
        board.worker = Pubkey::default();
        board.held = 0;
        board.dropped_by = worker;
    }
    emit_cpi!(ClaimDropped {
        intent,
        worker,
        refunded: held,
    });
    Ok(())
}
