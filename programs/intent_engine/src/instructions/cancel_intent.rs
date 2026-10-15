use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use intent_core::ext::SETTLE_EXT_TAGS;
use intent_core::lifecycle::{transition, Action, Status};

use crate::claims::honor_on_cancel;
use crate::errors::{core_err, EngineError};
use crate::events::IntentCancelled;
use crate::ext::Ext;
use crate::policy::{release_vault, IntentSigner};
use crate::state::{intent_recoverable, ClaimBoard, Intent, CLAIMS_SEED, VAULT_SEED};

#[event_cpi]
#[derive(Accounts)]
pub struct CancelIntent<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        has_one = owner @ EngineError::Unauthorized, has_one = input_mint,
        constraint = intent_recoverable(intent.load()?.version) @ EngineError::UnsupportedVersion
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
    #[account(
        mut,
        seeds = [CLAIMS_SEED, intent.key().as_ref()],
        bump = claims.load()?.bump
    )]
    pub claims: Option<AccountLoader<'info, ClaimBoard>>,
    /// CHECK: receives a claim's stake; matched against the board's worker or owner
    #[account(mut)]
    pub stake_to: Option<UncheckedAccount<'info>>,
}

pub fn handle_cancel_intent(ctx: Context<CancelIntent>, ext: Ext) -> Result<()> {
    ext.check(SETTLE_EXT_TAGS)?;
    let now = Clock::get()?.unix_timestamp;
    let (signer, claims) = {
        let mut intent = ctx.accounts.intent.load_mut()?;
        let status = Status::try_from(intent.status).map_err(core_err)?;
        let next = transition(status, Action::Cancel, now, intent.expires_at)
            .map_err(core_err)?
            .ok_or(EngineError::InvalidTransition)?;
        intent.status = next as u8;
        intent.agent_fee = 0;
        (
            IntentSigner {
                owner: intent.owner,
                nonce: intent.nonce.to_le_bytes(),
                bump: [intent.bump],
            },
            intent.claims,
        )
    };
    let stake = honor_on_cancel(
        claims,
        ctx.accounts.claims.as_ref(),
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
    emit_cpi!(IntentCancelled {
        intent: ctx.accounts.intent.key(),
        owner: signer.owner,
        refunded,
    });
    if let Some(moved) = stake {
        emit_cpi!(moved);
    }
    Ok(())
}
