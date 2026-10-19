use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};
use intent_core::PARAMS_LEN;

use crate::admission::{open_intent, Opening};
use crate::caps::charge_mint_cap;
use crate::errors::EngineError;
use crate::events::{FeeWithheld, IntentCreated, WITHHELD_TREASURY};
use crate::ext::Ext;
use crate::policy::{charge_lamports, charge_treasury};
use crate::state::{
    Committee, Config, Intent, MintCap, UserState, CONFIG_ADDRESS, CONFIG_VERSION, INTENT_SEED,
    MINT_CAP_SEED, MINT_CAP_VERSION, USER_SEED, USER_VERSION, VAULT_SEED,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub struct CreateIntentArgs {
    pub nonce: u64,
    pub kind: u8,
    pub flags: u16,
    pub params: [u8; PARAMS_LEN],
    pub expires_at: i64,
    pub ext: Ext,
    pub max_create_fee: u32,
    pub max_bounty: u32,
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(args: CreateIntentArgs)]
pub struct CreateIntent<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        address = CONFIG_ADDRESS,
        constraint = config.load()?.version == CONFIG_VERSION @ EngineError::UnsupportedVersion
    )]
    pub config: AccountLoader<'info, Config>,
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
        space = Intent::SPACE,
        seeds = [INTENT_SEED, owner.key().as_ref(), &args.nonce.to_le_bytes()],
        bump
    )]
    pub intent: AccountLoader<'info, Intent>,
    #[account(mint::token_program = input_token_program)]
    pub input_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mint::token_program = output_token_program)]
    pub output_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
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
    /// CHECK: only its key and program owner are read
    #[account(address = receiver.owner @ EngineError::ReceiverNotAllowed)]
    pub receiver_authority: UncheckedAccount<'info>,
    #[account(
        init,
        payer = owner,
        seeds = [VAULT_SEED, intent.key().as_ref()],
        bump,
        token::mint = input_mint,
        token::authority = intent,
        token::token_program = input_token_program
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub input_token_program: Interface<'info, TokenInterface>,
    pub output_token_program: Interface<'info, TokenInterface>,
    /// CHECK: receives the create fee; bound to the configured fee recipient
    #[account(
        mut,
        address = config.load()?.fee_recipient @ EngineError::TreasuryMismatch
    )]
    pub treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub committee: Option<AccountLoader<'info, Committee>>,
    #[account(
        mut,
        seeds = [MINT_CAP_SEED, input_mint.key().as_ref()],
        bump = mint_cap.load()?.bump,
        constraint = mint_cap.load()?.version == MINT_CAP_VERSION @ EngineError::UnsupportedVersion
    )]
    pub mint_cap: Option<AccountLoader<'info, MintCap>>,
}

pub fn handle_create_intent(ctx: Context<CreateIntent>, args: CreateIntentArgs) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let owner = ctx.accounts.owner.key();
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
            rent_payer: owner,
            intent_bump: ctx.bumps.intent,
            vault_bump: ctx.bumps.vault,
            committee: ctx.accounts.committee.as_ref(),
            mandate: None,
        },
        &args,
        now,
    )?;
    let escrowed = admitted.decoded.escrow_amount();
    charge_mint_cap(
        &ctx.accounts.config,
        ctx.accounts.mint_cap.as_ref(),
        &ctx.accounts.intent,
        &ctx.accounts.input_mint.key(),
        escrowed,
        now,
    )?;
    transfer_checked(
        CpiContext::new(
            ctx.accounts.input_token_program.key(),
            TransferChecked {
                from: ctx.accounts.owner_input.to_account_info(),
                mint: ctx.accounts.input_mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        escrowed,
        ctx.accounts.input_mint.decimals,
    )?;
    let create_fee = charge_treasury(
        &ctx.accounts.system_program,
        ctx.accounts.owner.to_account_info(),
        ctx.accounts.treasury.to_account_info(),
        admitted.create_fee,
    )?;
    charge_lamports(
        &ctx.accounts.system_program,
        ctx.accounts.owner.to_account_info(),
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
        rent_payer: owner,
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
    Ok(())
}
