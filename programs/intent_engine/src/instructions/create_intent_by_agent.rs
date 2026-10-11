use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use intent_core::ext::partner;
use intent_core::kinds::Intent as CoreIntent;

use crate::admission::{open_intent, Opening};
use crate::errors::{core_err, EngineError};
use crate::events::{FeeWithheld, IntentCreated, MandateUsed, WITHHELD_TREASURY};
use crate::instructions::CreateIntentArgs;
use crate::policy::{charge_lamports, charge_treasury, Draw};
use crate::state::{
    Config, Intent, Mandate, UserState, CONFIG_ADDRESS, CONFIG_VERSION, DELEGATE_SEED, INTENT_SEED,
    MANDATE_VERSION, USER_SEED, USER_VERSION, VAULT_SEED,
};

#[event_cpi]
#[derive(Accounts)]
#[instruction(args: CreateIntentArgs)]
pub struct CreateIntentByAgent<'info> {
    #[account(mut)]
    pub agent: Signer<'info>,
    /// CHECK: bound to the mandate's owner
    #[account(address = mandate.load()?.owner @ EngineError::Unauthorized)]
    pub owner: UncheckedAccount<'info>,
    #[account(
        mut,
        has_one = owner @ EngineError::Unauthorized,
        has_one = agent @ EngineError::Unauthorized,
        constraint = mandate.load()?.version == MANDATE_VERSION @ EngineError::UnsupportedVersion
    )]
    pub mandate: AccountLoader<'info, Mandate>,
    #[account(
        address = CONFIG_ADDRESS,
        constraint = config.load()?.version == CONFIG_VERSION @ EngineError::UnsupportedVersion
    )]
    pub config: AccountLoader<'info, Config>,
    #[account(
        seeds = [USER_SEED, owner.key().as_ref()],
        bump = user_state.load()?.bump,
        constraint = user_state.load()?.version == USER_VERSION @ EngineError::UnsupportedVersion,
        has_one = owner @ EngineError::Unauthorized
    )]
    pub user_state: AccountLoader<'info, UserState>,
    #[account(
        init,
        payer = agent,
        space = Intent::SPACE,
        seeds = [INTENT_SEED, owner.key().as_ref(), &args.nonce.to_le_bytes()],
        bump
    )]
    pub intent: AccountLoader<'info, Intent>,
    #[account(
        address = mandate.load()?.input_mint @ EngineError::MandateMismatch,
        mint::token_program = input_token_program
    )]
    pub input_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        address = mandate.load()?.output_mint @ EngineError::MandateMismatch,
        mint::token_program = output_token_program
    )]
    pub output_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        address = mandate.load()?.input_account @ EngineError::MandateMismatch,
        token::mint = input_mint,
        token::authority = owner,
        token::token_program = input_token_program
    )]
    pub owner_input: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        address = mandate.load()?.output_account @ EngineError::MandateMismatch,
        token::mint = output_mint,
        token::token_program = output_token_program
    )]
    pub receiver: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the receiver's owner; the receiver is the account the owner named in the mandate
    #[account(address = receiver.owner @ EngineError::ReceiverNotAllowed)]
    pub receiver_authority: UncheckedAccount<'info>,
    #[account(
        init,
        payer = agent,
        seeds = [VAULT_SEED, intent.key().as_ref()],
        bump,
        token::mint = input_mint,
        token::authority = intent,
        token::token_program = input_token_program
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: program-derived signer that spends only what the owner delegated to it
    #[account(seeds = [DELEGATE_SEED, owner.key().as_ref()], bump)]
    pub delegate: UncheckedAccount<'info>,
    pub input_token_program: Interface<'info, TokenInterface>,
    pub output_token_program: Interface<'info, TokenInterface>,
    /// CHECK: receives the create fee; bound to the configured fee recipient
    #[account(
        mut,
        address = config.load()?.fee_recipient @ EngineError::TreasuryMismatch
    )]
    pub treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_intent_by_agent(
    ctx: Context<CreateIntentByAgent>,
    args: CreateIntentArgs,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let owner = ctx.accounts.owner.key();
    let agent = ctx.accounts.agent.key();
    require!(args.flags == 0, EngineError::MandateMismatch);
    let named = partner(&args.ext.0).map_err(core_err)?;
    let decoded = CoreIntent::decode(args.kind, &args.params).map_err(core_err)?;
    let (usage, serial, agent_fee) = {
        let mandate = ctx.accounts.mandate.load()?;
        require!(
            mandate.epoch == ctx.accounts.user_state.load()?.epoch,
            EngineError::MandateRevoked
        );
        let fixed = named.map_or((Pubkey::default(), 0), |p| {
            (Pubkey::new_from_array(p.key), p.bps)
        });
        require!(
            fixed == (mandate.partner, mandate.partner_bps),
            EngineError::MandateMismatch
        );
        let usage = mandate
            .limits()
            .admit(mandate.usage(), &decoded, args.expires_at, now)
            .map_err(core_err)?;
        (usage, mandate.serial, mandate.agent_fee)
    };
    {
        let mut mandate = ctx.accounts.mandate.load_mut()?;
        mandate.spent = usage.spent;
        mandate.intents = usage.intents;
    }
    let admitted = open_intent(
        &Opening {
            config: &ctx.accounts.config,
            user_state: &ctx.accounts.user_state,
            intent: &ctx.accounts.intent,
            input_mint: &ctx.accounts.input_mint,
            output_mint: &ctx.accounts.output_mint,
            receiver: &ctx.accounts.receiver.to_account_info(),
            receiver_authority: &ctx.accounts.receiver_authority.to_account_info(),
            owner,
            rent_payer: agent,
            intent_bump: ctx.bumps.intent,
            vault_bump: ctx.bumps.vault,
            mandate: Some((ctx.accounts.mandate.key(), serial, agent_fee)),
        },
        &args,
        now,
    )?;
    let escrowed = admitted.decoded.escrow_amount();
    let draw = Draw {
        token_program: &ctx.accounts.input_token_program,
        from: ctx.accounts.owner_input.to_account_info(),
        mint: &ctx.accounts.input_mint,
        delegate: ctx.accounts.delegate.to_account_info(),
        owner,
        bump: ctx.bumps.delegate,
    };
    draw.to(
        ctx.accounts.vault.to_account_info(),
        escrowed
            .checked_add(agent_fee)
            .ok_or(EngineError::Overflow)?,
    )?;
    let create_fee = charge_treasury(
        &ctx.accounts.system_program,
        ctx.accounts.agent.to_account_info(),
        ctx.accounts.treasury.to_account_info(),
        admitted.create_fee,
    )?;
    charge_lamports(
        &ctx.accounts.system_program,
        ctx.accounts.agent.to_account_info(),
        ctx.accounts.intent.to_account_info(),
        u64::from(admitted.bounty),
    )?;
    emit_cpi!(IntentCreated {
        intent: ctx.accounts.intent.key(),
        owner,
        nonce: args.nonce,
        kind: args.kind,
        input_mint: ctx.accounts.input_mint.key(),
        output_mint: ctx.accounts.output_mint.key(),
        receiver: ctx.accounts.receiver.key(),
        escrowed,
        expires_at: args.expires_at,
        rent_payer: agent,
        flags: args.flags,
        bounty: admitted.bounty,
        create_fee,
    });
    if create_fee < admitted.create_fee {
        emit_cpi!(FeeWithheld {
            intent: ctx.accounts.intent.key(),
            payee: ctx.accounts.treasury.key(),
            account: ctx.accounts.treasury.key(),
            fee: u64::from(admitted.create_fee),
            role: WITHHELD_TREASURY,
        });
    }
    emit_cpi!(MandateUsed {
        mandate: ctx.accounts.mandate.key(),
        intent: ctx.accounts.intent.key(),
        agent,
        escrowed,
        agent_fee,
        spent: usage.spent,
        intents: usage.intents,
    });
    Ok(())
}
