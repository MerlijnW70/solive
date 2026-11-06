use anchor_lang::prelude::*;

use crate::claims::{
    close_entry, escrow_deadline, honor_on_settle, read_board, stored_attestor, stored_bump,
};
use crate::errors::EngineError;
use crate::events::ClaimsClosed;
use crate::roster::is_listed;
use crate::state::{CLAIMS_SEED, CLAIM_LIST_SEED};

#[event_cpi]
#[derive(Accounts)]
pub struct SettleClaims<'info> {
    /// CHECK: the board's escrow, read only to learn whether it can still be released
    pub intent: UncheckedAccount<'info>,
    /// CHECK: the escrow's claims board in its current or an earlier layout, read by hand
    #[account(
        mut,
        seeds = [CLAIMS_SEED, intent.key().as_ref()],
        bump = stored_bump(&board)?
    )]
    pub board: UncheckedAccount<'info>,
    /// CHECK: the board's recorded owner, paid a forfeited stake and the board's rent
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,
    /// CHECK: the board's recorded worker, refunded a stake the escrow failed
    #[account(mut)]
    pub worker: Option<UncheckedAccount<'info>>,
    /// CHECK: the escrow's claim list, closed with the board when the board records one; one already closed is skipped
    #[account(mut, seeds = [CLAIM_LIST_SEED, intent.key().as_ref()], bump)]
    pub claim_list: Option<UncheckedAccount<'info>>,
}

pub fn handle_settle_claims(ctx: Context<SettleClaims>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let escrow = ctx.accounts.intent.to_account_info();
    let open = escrow_deadline(&escrow, now)?.is_some();
    let board = ctx.accounts.board.to_account_info();
    let stored = read_board(&board, true)?;
    require_keys_eq!(
        ctx.accounts.owner.key(),
        stored.owner,
        EngineError::StakeAccountMismatch
    );
    if let Some(worker) = ctx.accounts.worker.as_ref() {
        require_keys_eq!(
            worker.key(),
            stored.worker,
            EngineError::StakeAccountMismatch
        );
    }
    let owner = ctx.accounts.owner.to_account_info();
    let worker = ctx.accounts.worker.as_ref().map(|a| a.to_account_info());
    let honored = honor_on_settle(&board, &stored, &owner, worker.as_ref(), now, open)?;
    let moved = honored.moved.is_some();
    if let Some(moved) = honored.moved {
        emit_cpi!(moved);
    }
    if let Some(mut lapsed) = honored.lapsed {
        lapsed.attestor = stored_attestor(&escrow);
        emit_cpi!(lapsed);
    }
    if open {
        require!(moved, EngineError::InvalidTransition);
        return Ok(());
    }
    if is_listed(&stored) {
        let list = ctx
            .accounts
            .claim_list
            .as_ref()
            .ok_or(EngineError::ClaimListMissing)?
            .to_account_info();
        if *list.owner == crate::ID {
            close_entry(&list, &owner)?;
        }
    }
    close_entry(&board, &owner)?;
    emit_cpi!(ClaimsClosed {
        intent: stored.intent,
        owner: stored.owner,
    });
    Ok(())
}
