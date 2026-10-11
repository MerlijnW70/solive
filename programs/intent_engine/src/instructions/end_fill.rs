use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use intent_core::ext::FILL_EXT_TAGS;
use intent_core::kinds::Intent as CoreIntent;
use intent_core::lifecycle::{transition, Action, Status};

use crate::errors::{core_err, EngineError};
use crate::events::FillEnded;
use crate::ext::Ext;
use crate::policy::{check_mint, deliver};
use crate::state::{Intent, INTENT_VERSION};

#[event_cpi]
#[derive(Accounts)]
pub struct EndFill<'info> {
    #[account(
        mut,
        has_one = output_mint, has_one = receiver,
        constraint = intent.load()?.version == INTENT_VERSION @ EngineError::UnsupportedVersion
    )]
    pub intent: AccountLoader<'info, Intent>,
    pub solver: Signer<'info>,
    #[account(mint::token_program = output_token_program)]
    pub output_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        token::mint = output_mint,
        token::token_program = output_token_program
    )]
    pub receiver: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = output_mint,
        token::token_program = output_token_program,
        constraint = solver_output.owner != intent.load()?.owner
            && solver_output.owner != receiver.owner @ EngineError::SolverOutputNotAllowed
    )]
    pub solver_output: Box<InterfaceAccount<'info, TokenAccount>>,
    pub output_token_program: Interface<'info, TokenInterface>,
}

pub fn handle_end_fill(ctx: Context<EndFill>, amount_out: u64, ext: Ext) -> Result<()> {
    ext.check(FILL_EXT_TAGS)?;
    let now = Clock::get()?.unix_timestamp;
    check_mint(&ctx.accounts.output_mint.to_account_info())?;
    let (decoded, escrowed, owner) = {
        let mut intent = ctx.accounts.intent.load_mut()?;
        let status = Status::try_from(intent.status).map_err(core_err)?;
        let next = transition(status, Action::End, now, intent.expires_at)
            .map_err(core_err)?
            .ok_or(EngineError::InvalidTransition)?;
        intent.status = next as u8;
        let decoded = CoreIntent::decode(intent.kind, &intent.params).map_err(core_err)?;
        let taken = intent.in_flight;
        intent.in_flight = 0;
        (decoded, taken, intent.owner)
    };
    let required = decoded.required_out(escrowed, now).map_err(core_err)?;
    let (before, after) = deliver(
        &ctx.accounts.output_token_program,
        ctx.accounts.solver_output.to_account_info(),
        &ctx.accounts.output_mint,
        &mut ctx.accounts.receiver,
        ctx.accounts.solver.to_account_info(),
        amount_out,
    )?;
    let delivered = decoded
        .settle_delta(escrowed, before, after, now)
        .map_err(core_err)?;
    emit_cpi!(FillEnded {
        intent: ctx.accounts.intent.key(),
        owner,
        solver: ctx.accounts.solver.key(),
        receiver: ctx.accounts.receiver.key(),
        delivered,
        required,
    });
    Ok(())
}
