use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use intent_core::delivery::cancel_ready;
use intent_core::ext::SETTLE_EXT_TAGS;
use intent_core::lifecycle::{transition, Action, Status};

use crate::caps::refund_mint_cap;
use crate::claims::{cancel_board, check_cancel_review, honor_on_cancel, stored_attestor};
use crate::delivery::checked_book;
use crate::errors::{core_err, EngineError};
use crate::events::IntentCancelled;
use crate::ext::Ext;
use crate::policy::{release_vault, IntentSigner};
use crate::state::{intent_readable, Intent, CLAIMS_SEED, VAULT_SEED};

#[event_cpi]
#[derive(Accounts)]
pub struct CancelIntent<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        has_one = owner @ EngineError::Unauthorized, has_one = input_mint,
        constraint = intent_readable(intent.load()?.version) @ EngineError::AccountOutdated
    )]
    pub intent: AccountLoader<'info, Intent>,
    #[account(
        mut,
        seeds = [VAULT_SEED, intent.key().as_ref()],
        bump = intent.load()?.vault_bump,
        token::mint = input_mint,
        token::authority = intent,
        token::token_program = token_program
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mint::token_program = token_program)]
    pub input_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        token::mint = input_mint,
        token::authority = owner,
        token::token_program = token_program
    )]
    pub refund_to: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: the intent's claims board, read by hand so a board of an earlier version, or one closed as legacy, still lets the owner cancel
    #[account(mut, seeds = [CLAIMS_SEED, intent.key().as_ref()], bump)]
    pub claims: Option<UncheckedAccount<'info>>,
    /// CHECK: receives a claim's stake; matched against the board's worker or owner
    #[account(mut)]
    pub stake_to: Option<UncheckedAccount<'info>>,
    /// CHECK: the input mint's cap, read by hand so a cap of an earlier version, or none at all, never blocks a refund
    #[account(mut)]
    pub mint_cap: Option<UncheckedAccount<'info>>,
    /// CHECK: the intent's delivery book, checked by hand against its seeds and read for its cancel notice; one never created leaves cancel immediate
    pub book: UncheckedAccount<'info>,
}

pub fn handle_cancel_intent(ctx: Context<CancelIntent>, ext: Ext) -> Result<()> {
    ext.check(SETTLE_EXT_TAGS)?;
    let now = Clock::get()?.unix_timestamp;
    let (next, claims) = {
        let intent = ctx.accounts.intent.load()?;
        let status = Status::try_from(intent.status).map_err(core_err)?;
        let next = transition(status, Action::Cancel, now, intent.expires_at)
            .map_err(core_err)?
            .ok_or(EngineError::InvalidTransition)?;
        (next, intent.claims)
    };
    if let Some(book) = checked_book(
        &ctx.accounts.book.to_account_info(),
        &ctx.accounts.intent.key(),
    )? {
        cancel_ready(book.cancel_at, now).map_err(core_err)?;
    }
    let board = ctx.accounts.claims.as_ref().map(|a| a.to_account_info());
    let stored = cancel_board(claims, board.as_ref())?;
    check_cancel_review(stored.as_ref(), now)?;
    let signer = {
        let mut intent = ctx.accounts.intent.load_mut()?;
        intent.status = next as u8;
        intent.agent_fee = 0;
        IntentSigner {
            owner: intent.owner,
            nonce: intent.nonce.to_le_bytes(),
            bump: [intent.bump],
        }
    };
    let honored = honor_on_cancel(
        stored.as_ref(),
        board.as_ref(),
        ctx.accounts
            .stake_to
            .as_ref()
            .map(|a| a.to_account_info())
            .as_ref(),
        now,
    )?;
    let refunded = release_vault(
        &ctx.accounts.token_program,
        &ctx.accounts.vault,
        &ctx.accounts.input_mint,
        ctx.accounts.refund_to.to_account_info(),
        ctx.accounts.intent.to_account_info(),
        &signer,
    )?;
    refund_mint_cap(
        ctx.accounts
            .mint_cap
            .as_ref()
            .map(|a| a.to_account_info())
            .as_ref(),
        &ctx.accounts.intent,
        refunded,
    )?;
    emit_cpi!(IntentCancelled {
        intent: ctx.accounts.intent.key(),
        owner: signer.owner,
        refunded,
    });
    if let Some(moved) = honored.moved {
        emit_cpi!(moved);
    }
    if let Some(mut lapsed) = honored.lapsed {
        lapsed.attestor = stored_attestor(&ctx.accounts.intent.to_account_info());
        emit_cpi!(lapsed);
    }
    Ok(())
}
