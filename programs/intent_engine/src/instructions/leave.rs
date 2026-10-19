use anchor_lang::prelude::*;

use crate::claims::escrow_deadline;
use crate::errors::EngineError;
use crate::events::LineLeft;
use crate::state::{Standby, STANDBY_SEED, STANDBY_VERSION};

#[event_cpi]
#[derive(Accounts)]
#[instruction(seq: u32)]
pub struct Leave<'info> {
    pub caller: Signer<'info>,
    /// CHECK: names the entry, whose address derives from it, and is read only to learn whether the escrow is still open
    pub intent: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [STANDBY_SEED, intent.key().as_ref(), &seq.to_le_bytes()],
        bump = entry.load()?.bump,
        constraint = entry.load()?.version == STANDBY_VERSION @ EngineError::AccountOutdated,
        close = worker
    )]
    pub entry: AccountLoader<'info, Standby>,
    /// CHECK: the entry's worker, paid its stake and rent
    #[account(mut, address = entry.load()?.worker @ EngineError::StakeAccountMismatch)]
    pub worker: UncheckedAccount<'info>,
}

pub fn handle_leave(ctx: Context<Leave>, seq: u32) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let worker = ctx.accounts.worker.key();
    let open = escrow_deadline(&ctx.accounts.intent.to_account_info(), now)?.is_some();
    require!(
        !open || ctx.accounts.caller.key() == worker,
        EngineError::Unauthorized
    );
    emit_cpi!(LineLeft {
        intent: ctx.accounts.intent.key(),
        worker,
        seq,
        refunded: ctx.accounts.entry.to_account_info().lamports(),
    });
    Ok(())
}
