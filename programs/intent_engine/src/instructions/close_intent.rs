use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use intent_core::clock::elapsed;
use intent_core::ext::SETTLE_EXT_TAGS;
use intent_core::lifecycle::{transition, Action, Status};

use crate::caps::refund_mint_cap;
use crate::errors::{core_err, EngineError};
use crate::events::IntentClosed;
use crate::ext::Ext;
use crate::policy::{
    check_refund_target, close_vault, move_lamports, pay_from_vault, IntentSigner,
};
use crate::state::{intent_readable, Intent, HELD_CLAIM_SECS, VAULT_SEED};

#[event_cpi]
#[derive(Accounts)]
pub struct CloseIntent<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(
        mut,
        has_one = owner @ EngineError::Unauthorized,
        has_one = rent_payer @ EngineError::Unauthorized,
        has_one = input_mint,
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
    /// CHECK: must satisfy refundable for the intent owner before any transfer
    #[account(mut)]
    pub refund_to: UncheckedAccount<'info>,
    /// CHECK: the owner's canonical token account, read to decide where refunds may go
    #[account(
        address = get_associated_token_address_with_program_id(
            &intent.load()?.owner,
            &input_mint.key(),
            &token_program.key()
        ) @ EngineError::RefundNotCanonical
    )]
    pub canonical_refund: UncheckedAccount<'info>,
    /// CHECK: bound to the intent owner by has_one
    pub owner: UncheckedAccount<'info>,
    /// CHECK: bound to the intent's rent payer by has_one
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: the input mint's cap, read by hand so a cap of an earlier version, or none at all, never blocks a refund
    #[account(mut)]
    pub mint_cap: Option<UncheckedAccount<'info>>,
}

pub fn handle_close_intent(ctx: Context<CloseIntent>, ext: Ext) -> Result<()> {
    ext.check(SETTLE_EXT_TAGS)?;
    let now = Clock::get()?.unix_timestamp;
    let (signer, bounty, cancelled) = {
        let intent = ctx.accounts.intent.load()?;
        let status = Status::try_from(intent.status).map_err(core_err)?;
        transition(status, Action::Close, now, intent.expires_at).map_err(core_err)?;
        require!(
            intent.held == 0 || elapsed(now, intent.expires_at, HELD_CLAIM_SECS),
            EngineError::SharesHeld
        );
        let signer = IntentSigner {
            owner: intent.owner,
            nonce: intent.nonce.to_le_bytes(),
            bump: [intent.bump],
        };
        (signer, intent.bounty, status == Status::Cancelled)
    };
    let swept = ctx.accounts.vault.amount;
    if swept > 0 {
        check_refund_target(
            &ctx.accounts.refund_to,
            &ctx.accounts.canonical_refund,
            &ctx.accounts.token_program.key(),
            &ctx.accounts.input_mint.key(),
            &signer.owner,
        )?;
        pay_from_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.input_mint,
            ctx.accounts.refund_to.to_account_info(),
            ctx.accounts.intent.to_account_info(),
            &signer,
            swept,
        )?;
    }
    refund_mint_cap(
        ctx.accounts
            .mint_cap
            .as_ref()
            .map(|a| a.to_account_info())
            .as_ref(),
        &ctx.accounts.intent,
        swept,
    )?;
    let rent_to = if ctx.accounts.rent_payer.executable {
        ctx.accounts.cranker.to_account_info()
    } else {
        ctx.accounts.rent_payer.to_account_info()
    };
    close_vault(
        &ctx.accounts.token_program,
        &ctx.accounts.vault,
        rent_to.clone(),
        ctx.accounts.intent.to_account_info(),
        &signer,
    )?;
    let earner = if cancelled {
        rent_to.clone()
    } else {
        ctx.accounts.cranker.to_account_info()
    };
    move_lamports(
        &ctx.accounts.intent.to_account_info(),
        &earner,
        u64::from(bounty),
    )?;
    ctx.accounts.intent.close(rent_to.clone())?;
    emit_cpi!(IntentClosed {
        intent: ctx.accounts.intent.key(),
        owner: signer.owner,
        swept,
        refund_to: ctx.accounts.refund_to.key(),
        by: ctx.accounts.cranker.key(),
        bounty,
        bounty_to: earner.key(),
        rent_to: rent_to.key(),
    });
    Ok(())
}
