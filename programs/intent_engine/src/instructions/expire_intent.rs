use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use intent_core::ext::SETTLE_EXT_TAGS;
use intent_core::lifecycle::{transition, Action, Status};

use crate::errors::{core_err, EngineError};
use crate::events::IntentExpired;
use crate::ext::Ext;
use crate::policy::{check_refund_target, move_lamports, release_vault, IntentSigner};
use crate::state::{intent_recoverable, Intent, VAULT_SEED};

#[event_cpi]
#[derive(Accounts)]
pub struct ExpireIntent<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(
        mut,
        has_one = input_mint,
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
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_expire_intent(ctx: Context<ExpireIntent>, ext: Ext) -> Result<()> {
    ext.check(SETTLE_EXT_TAGS)?;
    let now = Clock::get()?.unix_timestamp;
    let (signer, bounty) = {
        let mut intent = ctx.accounts.intent.load_mut()?;
        let status = Status::try_from(intent.status).map_err(core_err)?;
        let next = transition(status, Action::Expire, now, intent.expires_at)
            .map_err(core_err)?
            .ok_or(EngineError::InvalidTransition)?;
        intent.status = next as u8;
        let bounty = intent.bounty;
        intent.bounty = 0;
        intent.agent_fee = 0;
        let signer = IntentSigner {
            owner: intent.owner,
            nonce: intent.nonce.to_le_bytes(),
            bump: [intent.bump],
        };
        (signer, bounty)
    };
    check_refund_target(
        &ctx.accounts.refund_to,
        &ctx.accounts.canonical_refund,
        &ctx.accounts.token_program.key(),
        &ctx.accounts.input_mint.key(),
        &signer.owner,
    )?;
    let refunded = release_vault(
        &ctx.accounts.token_program,
        &ctx.accounts.vault,
        &ctx.accounts.input_mint,
        ctx.accounts.refund_to.to_account_info(),
        ctx.accounts.intent.to_account_info(),
        &signer,
    )?;
    move_lamports(
        &ctx.accounts.intent.to_account_info(),
        &ctx.accounts.cranker.to_account_info(),
        u64::from(bounty),
    )?;
    emit_cpi!(IntentExpired {
        intent: ctx.accounts.intent.key(),
        owner: signer.owner,
        refunded,
        refund_to: ctx.accounts.refund_to.key(),
        by: ctx.accounts.cranker.key(),
        bounty,
    });
    Ok(())
}
