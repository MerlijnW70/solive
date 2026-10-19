use anchor_lang::prelude::*;
use intent_core::claim::Slot;

use crate::claims::{escrow_deadline, hand_over, line_entries, line_of, move_lamports, slot_of};
use crate::errors::EngineError;
use crate::events::ClaimDropped;
use crate::state::{ClaimBoard, CLAIMS_SEED, CLAIMS_VERSION};

#[event_cpi]
#[derive(Accounts)]
pub struct DropClaim<'info> {
    #[account(mut)]
    pub worker: Signer<'info>,
    /// CHECK: names the board, whose address derives from it, and is read only to learn the escrow's deadline
    pub intent: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [CLAIMS_SEED, intent.key().as_ref()],
        bump = board.load()?.bump,
        constraint = board.load()?.version == CLAIMS_VERSION @ EngineError::UnsupportedVersion
    )]
    pub board: AccountLoader<'info, ClaimBoard>,
    /// CHECK: the worker of the first live entry in the line, checked against that entry
    #[account(mut)]
    pub next_worker: Option<UncheckedAccount<'info>>,
    /// CHECK: the line's entry at head + 0, checked against the address its sequence derives
    #[account(mut)]
    pub entry_0: Option<UncheckedAccount<'info>>,
    /// CHECK: the line's entry at head + 1, checked against the address its sequence derives
    #[account(mut)]
    pub entry_1: Option<UncheckedAccount<'info>>,
    /// CHECK: the line's entry at head + 2, checked against the address its sequence derives
    #[account(mut)]
    pub entry_2: Option<UncheckedAccount<'info>>,
    /// CHECK: the line's entry at head + 3, checked against the address its sequence derives
    #[account(mut)]
    pub entry_3: Option<UncheckedAccount<'info>>,
}

pub fn handle_drop_claim(ctx: Context<DropClaim>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let worker = ctx.accounts.worker.key();
    let (intent, held, waiting) = {
        let board = ctx.accounts.board.load()?;
        match slot_of(&board, now) {
            Slot::Held { worker: holder, .. } if holder == worker.to_bytes() => {}
            _ => return err!(EngineError::NotClaimant),
        }
        (board.intent, board.held, !line_of(&board).is_empty())
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
    let deadline = escrow_deadline(&ctx.accounts.intent.to_account_info(), now)?;
    if let (true, Some(expires_at)) = (waiting, deadline) {
        let entries = line_entries([
            &ctx.accounts.entry_0,
            &ctx.accounts.entry_1,
            &ctx.accounts.entry_2,
            &ctx.accounts.entry_3,
        ]);
        require!(!entries.is_empty(), EngineError::LineEntryMismatch);
        let next = ctx
            .accounts
            .next_worker
            .as_ref()
            .map(|a| a.to_account_info());
        if let Some(claimed) = hand_over(
            &ctx.accounts.board,
            &entries,
            next.as_ref(),
            now,
            expires_at,
        )? {
            emit_cpi!(claimed);
        }
    }
    Ok(())
}
