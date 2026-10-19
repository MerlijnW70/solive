use anchor_lang::prelude::*;
use intent_core::claim::{stake_on_settle, StakeTo};

use crate::claims::{clear, escrow_deadline, move_lamports, slot_of, stake_receiver};
use crate::errors::{core_err, EngineError};
use crate::events::{ClaimsClosed, StakeMoved};
use crate::state::{ClaimBoard, CLAIMS_SEED, CLAIMS_VERSION};

#[event_cpi]
#[derive(Accounts)]
pub struct SettleClaims<'info> {
    /// CHECK: the board's escrow, read only to learn whether it can still be released
    pub intent: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [CLAIMS_SEED, intent.key().as_ref()],
        bump = board.load()?.bump,
        constraint = board.load()?.version == CLAIMS_VERSION @ EngineError::UnsupportedVersion
    )]
    pub board: AccountLoader<'info, ClaimBoard>,
    /// CHECK: the board's recorded owner, paid a forfeited stake and the board's rent
    #[account(mut, address = board.load()?.owner @ EngineError::StakeAccountMismatch)]
    pub owner: UncheckedAccount<'info>,
    /// CHECK: the board's recorded worker, refunded a stake the escrow failed
    #[account(mut, address = board.load()?.worker @ EngineError::StakeAccountMismatch)]
    pub worker: Option<UncheckedAccount<'info>>,
}

pub fn handle_settle_claims(ctx: Context<SettleClaims>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let open = escrow_deadline(&ctx.accounts.intent.to_account_info(), now)?.is_some();
    let (intent, owner, worker, held, outcome) = {
        let board = ctx.accounts.board.load()?;
        let outcome = stake_on_settle(slot_of(&board, now), open).map_err(core_err)?;
        let receiver = outcome.map(|to| stake_receiver(&board, to));
        (
            board.intent,
            board.owner,
            board.worker,
            board.held,
            receiver.zip(outcome),
        )
    };
    if let Some(((to, role), side)) = outcome {
        let target = match side {
            StakeTo::Worker => ctx
                .accounts
                .worker
                .as_ref()
                .ok_or(EngineError::StakeAccountMismatch)?
                .to_account_info(),
            StakeTo::Owner => ctx.accounts.owner.to_account_info(),
        };
        move_lamports(&ctx.accounts.board.to_account_info(), &target, held)?;
        clear(&mut *ctx.accounts.board.load_mut()?);
        emit_cpi!(StakeMoved {
            intent,
            worker,
            to,
            amount: held,
            role,
        });
    } else if open {
        return err!(EngineError::InvalidTransition);
    }
    if !open {
        ctx.accounts
            .board
            .close(ctx.accounts.owner.to_account_info())?;
        emit_cpi!(ClaimsClosed { intent, owner });
    }
    Ok(())
}
