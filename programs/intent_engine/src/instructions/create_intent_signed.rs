use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use intent_core::sig::{offchain_envelope, SignedIntent};

use crate::admission::{open_intent, Opening};
use crate::errors::EngineError;
use crate::events::{FeeWithheld, IntentCreated, RelayerPaid, WITHHELD_TREASURY};
use crate::instructions::CreateIntentArgs;
use crate::policy::{charge_lamports, charge_treasury, verify_preceding_ed25519, Draw};
use crate::state::{
    Config, Intent, UserState, CONFIG_ADDRESS, CONFIG_VERSION, DELEGATE_SEED, INTENT_SEED,
    USER_SEED, USER_VERSION, VAULT_SEED,
};

#[event_cpi]
#[derive(Accounts)]
#[instruction(args: CreateIntentArgs, submit_by: i64)]
pub struct CreateIntentSigned<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: authorized by the Ed25519 signature verified in the handler
    pub owner: UncheckedAccount<'info>,
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
        payer = payer,
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
        payer = payer,
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
    #[account(
        mut,
        token::mint = input_mint,
        token::authority = payer,
        token::token_program = input_token_program
    )]
    pub relayer_fee_to: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub system_program: Program<'info, System>,
    /// CHECK: read only through the checked instructions-sysvar loaders
    pub instructions: UncheckedAccount<'info>,
}

pub fn handle_create_intent_signed(
    ctx: Context<CreateIntentSigned>,
    args: CreateIntentArgs,
    submit_by: i64,
    relayer_fee: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(now <= submit_by, EngineError::SignatureExpired);
    let owner = ctx.accounts.owner.key();
    let payer = ctx.accounts.payer.key();
    let domain = ctx.accounts.config.load()?.domain;
    let epoch = ctx.accounts.user_state.load()?.epoch;
    let preimage = SignedIntent {
        program: crate::ID.to_bytes(),
        domain,
        owner: owner.to_bytes(),
        owner_input: ctx.accounts.owner_input.key().to_bytes(),
        input_mint: ctx.accounts.input_mint.key().to_bytes(),
        output_mint: ctx.accounts.output_mint.key().to_bytes(),
        receiver: ctx.accounts.receiver.key().to_bytes(),
        nonce: args.nonce,
        expires_at: args.expires_at,
        submit_by,
        kind: args.kind,
        flags: args.flags,
        params: &args.params,
        epoch,
        ext_hash: solana_sha256_hasher::hashv(&[&args.ext.0]).to_bytes(),
        relayer_fee,
    }
    .preimage();
    let digest = solana_sha256_hasher::hashv(&[&preimage]).to_bytes();
    verify_preceding_ed25519(
        &ctx.accounts.instructions.to_account_info(),
        &owner,
        &offchain_envelope(&owner.to_bytes(), &digest),
    )?;
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
            rent_payer: payer,
            intent_bump: ctx.bumps.intent,
            vault_bump: ctx.bumps.vault,
            mandate: None,
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
    draw.to(ctx.accounts.vault.to_account_info(), escrowed)?;
    let paid_to = draw.fee(ctx.accounts.relayer_fee_to.as_deref(), relayer_fee)?;
    let create_fee = charge_treasury(
        &ctx.accounts.system_program,
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.treasury.to_account_info(),
        admitted.create_fee,
    )?;
    charge_lamports(
        &ctx.accounts.system_program,
        ctx.accounts.payer.to_account_info(),
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
        rent_payer: payer,
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
    if let Some(account) = paid_to {
        emit_cpi!(RelayerPaid {
            intent: ctx.accounts.intent.key(),
            relayer: payer,
            account,
            fee: relayer_fee,
        });
    }
    Ok(())
}
