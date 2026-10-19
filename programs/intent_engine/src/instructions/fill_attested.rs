use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::attested::{release_single, Fill, Judge, Release, Released};
use crate::errors::EngineError;
use crate::events::{FeeWithheld, IntentAttested};
use crate::ext::Ext;
use crate::state::{
    ClaimBoard, Config, Intent, MintCap, CLAIMS_SEED, CONFIG_ADDRESS, CONFIG_VERSION,
    INTENT_VERSION, MINT_CAP_SEED, MINT_CAP_VERSION, VAULT_SEED,
};

#[event_cpi]
#[derive(Accounts)]
pub struct FillAttested<'info> {
    pub solver: Signer<'info>,
    #[account(
        address = CONFIG_ADDRESS,
        constraint = config.load()?.version == CONFIG_VERSION @ EngineError::UnsupportedVersion
    )]
    pub config: AccountLoader<'info, Config>,
    #[account(
        mut,
        has_one = input_mint,
        constraint = intent.load()?.version == INTENT_VERSION @ EngineError::UnsupportedVersion
    )]
    pub intent: AccountLoader<'info, Intent>,
    #[account(
        mut,
        seeds = [VAULT_SEED, intent.key().as_ref()],
        bump = intent.load()?.vault_bump,
        token::mint = input_mint,
        token::authority = intent,
        token::token_program = input_token_program
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mint::token_program = input_token_program)]
    pub input_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: named by the attestation; the token program checks it holds the input mint
    #[account(mut)]
    pub payee: UncheckedAccount<'info>,
    #[account(
        mut,
        address = get_associated_token_address_with_program_id(
            &config.load()?.fee_recipient,
            &input_mint.key(),
            &input_token_program.key()
        ) @ EngineError::FeeAccountNotCanonical
    )]
    pub fee_to: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(
        mut,
        address = get_associated_token_address_with_program_id(
            &intent.load()?.partner,
            &input_mint.key(),
            &input_token_program.key()
        ) @ EngineError::PartnerAccountNotCanonical
    )]
    pub partner_to: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(mut, token::mint = input_mint, token::token_program = input_token_program)]
    pub judge_to: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub input_token_program: Interface<'info, TokenInterface>,
    /// CHECK: read only through the checked instructions-sysvar loaders
    pub instructions: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [CLAIMS_SEED, intent.key().as_ref()],
        bump = claims.load()?.bump
    )]
    pub claims: Option<AccountLoader<'info, ClaimBoard>>,
    /// CHECK: receives the claim's stake; matched against the board's worker or owner
    #[account(mut)]
    pub stake_to: Option<UncheckedAccount<'info>>,
    #[account(
        mut,
        seeds = [MINT_CAP_SEED, input_mint.key().as_ref()],
        bump = mint_cap.load()?.bump,
        constraint = mint_cap.load()?.version == MINT_CAP_VERSION @ EngineError::UnsupportedVersion
    )]
    pub mint_cap: Option<AccountLoader<'info, MintCap>>,
}

pub fn handle_fill_attested(
    mut ctx: Context<FillAttested>,
    amount_in: u64,
    result: u64,
    max_fee_bps: u16,
    ext: Ext,
) -> Result<()> {
    let accounts = &mut ctx.accounts;
    let released = release_single(
        Release {
            config: &accounts.config,
            intent: &accounts.intent,
            vault: &mut accounts.vault,
            input_mint: &accounts.input_mint,
            fee_to: accounts.fee_to.as_deref(),
            partner_to: accounts.partner_to.as_deref(),
            judge_to: accounts.judge_to.as_deref(),
            input_token_program: &accounts.input_token_program,
            instructions: accounts.instructions.to_account_info(),
            claims: accounts.claims.as_ref(),
            stake_to: accounts.stake_to.as_ref().map(|a| a.to_account_info()),
            mint_cap: accounts.mint_cap.as_ref(),
        },
        accounts.payee.to_account_info(),
        &Judge::Key,
        Fill {
            amount_in,
            result,
            max_fee_bps,
        },
        &ext,
    )?;
    let intent = ctx.accounts.intent.key();
    let payee = ctx.accounts.payee.key();
    let solver = ctx.accounts.solver.key();
    let Released {
        owner,
        attestor,
        tally,
        fees,
        withheld,
        stake,
        ..
    } = released;
    if let Some(moved) = stake {
        emit_cpi!(moved);
    }
    for fee in withheld {
        emit_cpi!(FeeWithheld {
            intent,
            payee: fee.payee,
            account: fee.account,
            fee: fee.fee,
            role: fee.role,
        });
    }
    emit_cpi!(IntentAttested {
        intent,
        owner,
        solver,
        payee,
        attestor,
        amount_in: tally.amount_in,
        result,
        fee: fees.protocol,
        net: fees.net,
        filled: tally.filled,
        remaining: tally.remaining,
        partner_fee: fees.partner,
    });
    Ok(())
}
