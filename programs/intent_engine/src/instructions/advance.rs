use anchor_lang::prelude::*;
use intent_core::claim::{Slot, StakeTo};

use crate::claims::{
    clear, escrow_deadline, hand_over, line_entries, line_of, move_lamports, slot_of,
    stake_receiver,
};
use crate::errors::{core_err, EngineError};
use crate::events::StakeMoved;
use crate::state::{ClaimBoard, CLAIMS_SEED, CLAIMS_VERSION};

#[event_cpi]
#[derive(Accounts)]
pub struct Advance<'info> {
    /// CHECK: names the board, whose address derives from it, and is read only to learn the escrow's deadline
    pub intent: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [CLAIMS_SEED, intent.key().as_ref()],
        bump = board.load()?.bump,
        constraint = board.load()?.version == CLAIMS_VERSION @ EngineError::UnsupportedVersion
    )]
    pub board: AccountLoader<'info, ClaimBoard>,
    /// CHECK: the board's recorded owner, paid a lapsed claim's stake
    #[account(mut, address = board.load()?.owner @ EngineError::StakeAccountMismatch)]
    pub owner: UncheckedAccount<'info>,
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

pub fn handle_advance(ctx: Context<Advance>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let expires_at = escrow_deadline(&ctx.accounts.intent.to_account_info(), now)?
        .ok_or(EngineError::InvalidTransition)?;
    let (intent, slot, held, owner, role) = {
        let board = ctx.accounts.board.load()?;
        let slot = slot_of(&board, now);
        line_of(&board).check_advance(slot).map_err(core_err)?;
        let (owner, role) = stake_receiver(&board, StakeTo::Owner);
        (board.intent, slot, board.held, owner, role)
    };
    let entries = line_entries([
        &ctx.accounts.entry_0,
        &ctx.accounts.entry_1,
        &ctx.accounts.entry_2,
        &ctx.accounts.entry_3,
    ]);
    require!(!entries.is_empty(), EngineError::LineEntryMismatch);
    if let Slot::Lapsed { worker } = slot {
        move_lamports(
            &ctx.accounts.board.to_account_info(),
            &ctx.accounts.owner.to_account_info(),
            held,
        )?;
        clear(&mut *ctx.accounts.board.load_mut()?);
        emit_cpi!(StakeMoved {
            intent,
            worker: Pubkey::new_from_array(worker),
            to: owner,
            amount: held,
            role,
        });
    }
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
    Ok(())
}
