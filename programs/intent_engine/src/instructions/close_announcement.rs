use anchor_lang::prelude::*;
use intent_core::delivery::{closable, AnnState};

use crate::claims::close_entry;
use crate::delivery::{intent_open, read_book, stored_book_bump, write_book};
use crate::errors::{core_err, EngineError};
use crate::events::{AnnouncementClosed, DeliveryBookClosed};
use crate::state::{Announcement, ANNOUNCEMENT_VERSION, DELIVERY_BOOK_SEED};

#[event_cpi]
#[derive(Accounts)]
pub struct CloseAnnouncement<'info> {
    pub by: Signer<'info>,
    #[account(
        mut,
        constraint = announcement.load()?.version == ANNOUNCEMENT_VERSION @ EngineError::AccountOutdated
    )]
    pub announcement: AccountLoader<'info, Announcement>,
    /// CHECK: the announcement's intent, read only to tell whether it is still open
    #[account(address = announcement.load()?.intent @ EngineError::AnnouncementMismatch)]
    pub intent: UncheckedAccount<'info>,
    /// CHECK: the intent's delivery book in its current or earlier layout, read by hand
    #[account(
        mut,
        seeds = [DELIVERY_BOOK_SEED, intent.key().as_ref()],
        bump = stored_book_bump(&book)?
    )]
    pub book: UncheckedAccount<'info>,
    /// CHECK: the wallet that paid the announcement's rent, which gets it back
    #[account(mut, address = announcement.load()?.payer @ EngineError::RentRecipientMismatch)]
    pub rent_to: UncheckedAccount<'info>,
}

pub fn handle_close_announcement(ctx: Context<CloseAnnouncement>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let open = intent_open(&ctx.accounts.intent.to_account_info(), now)?;
    let (intent, seq, worker) = {
        let stored = ctx.accounts.announcement.load()?;
        let state = AnnState::try_from(stored.state).map_err(core_err)?;
        let by_worker = ctx.accounts.by.key() == stored.worker;
        closable(
            state,
            by_worker,
            open,
            now,
            stored.expires_at,
            stored.paid_at,
        )
        .map_err(core_err)?;
        require!(
            stored.held == 0 || ctx.accounts.intent.data_is_empty(),
            EngineError::SharesHeld
        );
        (stored.intent, stored.seq, stored.worker)
    };
    let book = ctx.accounts.book.to_account_info();
    let live = read_book(&book)?
        .live
        .checked_sub(1)
        .ok_or(EngineError::Overflow)?;
    write_book(&book, |b| b.live = live)?;
    let lamports = close_entry(
        &ctx.accounts.announcement.to_account_info(),
        &ctx.accounts.rent_to.to_account_info(),
    )?;
    emit_cpi!(AnnouncementClosed {
        intent,
        announcement: ctx.accounts.announcement.key(),
        seq,
        worker,
        rent_to: ctx.accounts.rent_to.key(),
        lamports,
        by: ctx.accounts.by.key(),
    });
    Ok(())
}

#[event_cpi]
#[derive(Accounts)]
pub struct CloseDeliveryBook<'info> {
    pub by: Signer<'info>,
    /// CHECK: the book's intent, read only to tell whether it is still open; the book's seeds bind it
    pub intent: UncheckedAccount<'info>,
    /// CHECK: the intent's delivery book in its current or earlier layout, read by hand
    #[account(
        mut,
        seeds = [DELIVERY_BOOK_SEED, intent.key().as_ref()],
        bump = stored_book_bump(&book)?,
        constraint = read_book(&book)?.intent == intent.key() @ EngineError::BookMismatch
    )]
    pub book: UncheckedAccount<'info>,
    /// CHECK: the wallet that paid the book's rent, which gets it back
    #[account(mut, address = read_book(&book)?.payer @ EngineError::RentRecipientMismatch)]
    pub rent_to: UncheckedAccount<'info>,
}

pub fn handle_close_delivery_book(ctx: Context<CloseDeliveryBook>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        !intent_open(&ctx.accounts.intent.to_account_info(), now)?,
        EngineError::DeliveryBookOpen
    );
    let (intent, next_seq) = {
        let book = read_book(&ctx.accounts.book.to_account_info())?;
        require!(book.live == 0, EngineError::DeliveryBookLive);
        (book.intent, book.next_seq)
    };
    let lamports = close_entry(
        &ctx.accounts.book.to_account_info(),
        &ctx.accounts.rent_to.to_account_info(),
    )?;
    emit_cpi!(DeliveryBookClosed {
        intent,
        book: ctx.accounts.book.key(),
        next_seq,
        rent_to: ctx.accounts.rent_to.key(),
        lamports,
        by: ctx.accounts.by.key(),
    });
    Ok(())
}
