use anchor_lang::prelude::*;
use intent_core::delivery::cancel_at;
use intent_core::lifecycle::Status;

use crate::errors::{core_err, EngineError};
use crate::events::CancelRequested;
use crate::state::{
    DeliveryBook, Intent, DELIVERY_BOOK_SEED, DELIVERY_BOOK_VERSION, INTENT_VERSION,
};

#[event_cpi]
#[derive(Accounts)]
pub struct RequestCancel<'info> {
    pub owner: Signer<'info>,
    #[account(
        has_one = owner @ EngineError::Unauthorized,
        constraint = intent.load()?.version == INTENT_VERSION @ EngineError::AccountOutdated
    )]
    pub intent: AccountLoader<'info, Intent>,
    #[account(
        mut,
        seeds = [DELIVERY_BOOK_SEED, intent.key().as_ref()],
        bump = book.load()?.bump,
        constraint = book.load()?.version == DELIVERY_BOOK_VERSION @ EngineError::AccountOutdated,
        constraint = book.load()?.intent == intent.key() @ EngineError::BookMismatch
    )]
    pub book: AccountLoader<'info, DeliveryBook>,
}

pub fn handle_request_cancel(ctx: Context<RequestCancel>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let owner = {
        let intent = ctx.accounts.intent.load()?;
        let status = Status::try_from(intent.status).map_err(core_err)?;
        require!(
            status == Status::Open && now < intent.expires_at,
            EngineError::InvalidTransition
        );
        intent.owner
    };
    let at = {
        let mut book = ctx.accounts.book.load_mut()?;
        require!(book.cancel_at == 0, EngineError::CancelAlreadyRequested);
        book.cancel_at = cancel_at(now);
        book.cancel_at
    };
    emit_cpi!(CancelRequested {
        intent: ctx.accounts.intent.key(),
        owner,
        cancel_at: at,
    });
    Ok(())
}
