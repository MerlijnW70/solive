use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use intent_core::ext::MAX_PARTNER_BPS;
use intent_core::mandate::{lane_of, Limits};

use crate::errors::{core_err, EngineError};
use crate::events::MandateCreated;
use crate::policy::{check_mint, refundable};
use crate::state::{Mandate, UserState, MANDATE_SEED, MANDATE_VERSION, USER_SEED, USER_VERSION};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct MandateArgs {
    pub id: u64,
    pub agent: Pubkey,
    pub kinds: u8,
    pub per_intent: u64,
    pub total: u64,
    pub max_intents: u32,
    pub max_ttl: i64,
    pub valid_until: i64,
    pub floor_out: u64,
    pub floor_in: u64,
    pub partner: Pubkey,
    pub partner_bps: u16,
    pub agent_fee: u64,
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(args: MandateArgs)]
pub struct CreateMandate<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [USER_SEED, owner.key().as_ref()],
        bump = user_state.load()?.bump,
        constraint = user_state.load()?.version == USER_VERSION @ EngineError::UnsupportedVersion,
        has_one = owner @ EngineError::Unauthorized
    )]
    pub user_state: AccountLoader<'info, UserState>,
    #[account(
        init,
        payer = owner,
        space = Mandate::SPACE,
        seeds = [MANDATE_SEED, owner.key().as_ref(), args.agent.as_ref(), &args.id.to_le_bytes()],
        bump
    )]
    pub mandate: AccountLoader<'info, Mandate>,
    #[account(mint::token_program = input_token_program)]
    pub input_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mint::token_program = output_token_program)]
    pub output_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        token::mint = input_mint,
        token::authority = owner,
        token::token_program = input_token_program
    )]
    pub owner_input: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        token::mint = output_mint,
        token::token_program = output_token_program
    )]
    pub receiver: Box<InterfaceAccount<'info, TokenAccount>>,
    pub input_token_program: Interface<'info, TokenInterface>,
    pub output_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_mandate(ctx: Context<CreateMandate>, args: MandateArgs) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let limits = Limits {
        kinds: args.kinds,
        per_intent: args.per_intent,
        total: args.total,
        max_intents: args.max_intents,
        max_ttl: args.max_ttl,
        valid_until: args.valid_until,
        floor_out: args.floor_out,
        floor_in: args.floor_in,
        agent_fee: args.agent_fee,
    }
    .validate(now)
    .map_err(core_err)?;
    let owner = ctx.accounts.owner.key();
    require!(
        args.agent != Pubkey::default() && args.agent != owner,
        EngineError::MandateInvalid
    );
    require!(
        (args.partner_bps == 0) == (args.partner == Pubkey::default())
            && args.partner_bps <= MAX_PARTNER_BPS,
        EngineError::MandateInvalid
    );
    let input_mint = ctx.accounts.input_mint.key();
    let output_mint = ctx.accounts.output_mint.key();
    require_keys_neq!(input_mint, output_mint, EngineError::SameMint);
    check_mint(&ctx.accounts.input_mint.to_account_info())?;
    check_mint(&ctx.accounts.output_mint.to_account_info())?;
    require!(
        refundable(
            &ctx.accounts.receiver.to_account_info(),
            &ctx.accounts.output_token_program.key(),
            &output_mint,
            &owner,
        ),
        EngineError::ReceiverNotAllowed
    );
    let (epoch, serial) = {
        let mut user = ctx.accounts.user_state.load_mut()?;
        user.grants = user
            .grants
            .checked_add(1)
            .filter(|serial| lane_of(*serial).is_some())
            .ok_or(EngineError::MandateInvalid)?;
        (user.epoch, user.grants)
    };
    {
        let mut mandate = ctx.accounts.mandate.load_init()?;
        mandate.owner = owner;
        mandate.agent = args.agent;
        mandate.input_mint = input_mint;
        mandate.output_mint = output_mint;
        mandate.partner = args.partner;
        mandate.input_account = ctx.accounts.owner_input.key();
        mandate.output_account = ctx.accounts.receiver.key();
        mandate.id = args.id;
        mandate.epoch = epoch;
        mandate.serial = serial;
        mandate.valid_until = limits.valid_until;
        mandate.max_ttl = limits.max_ttl;
        mandate.per_intent = limits.per_intent;
        mandate.total = limits.total;
        mandate.floor_out = limits.floor_out;
        mandate.floor_in = limits.floor_in;
        mandate.agent_fee = limits.agent_fee;
        mandate.max_intents = limits.max_intents;
        mandate.partner_bps = args.partner_bps;
        mandate.kinds = limits.kinds;
        mandate.version = MANDATE_VERSION;
        mandate.bump = ctx.bumps.mandate;
    }
    emit_cpi!(MandateCreated {
        mandate: ctx.accounts.mandate.key(),
        owner,
        agent: args.agent,
        id: args.id,
        serial,
        input_mint,
        output_mint,
        input_account: ctx.accounts.owner_input.key(),
        output_account: ctx.accounts.receiver.key(),
        kinds: limits.kinds,
        per_intent: limits.per_intent,
        total: limits.total,
        max_intents: limits.max_intents,
        max_ttl: limits.max_ttl,
        valid_until: limits.valid_until,
        floor_out: limits.floor_out,
        floor_in: limits.floor_in,
        partner: args.partner,
        partner_bps: args.partner_bps,
        epoch,
        agent_fee: limits.agent_fee,
    });
    Ok(())
}
