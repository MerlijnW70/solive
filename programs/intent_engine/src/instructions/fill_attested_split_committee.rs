use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::attested::{
    release_split, Fill, Judge, Opening, Release, Released, SplitClaim, SplitReleased,
};
use crate::errors::EngineError;
use crate::events::{CommitteeAttested, DeliveryReleased, FeeWithheld, IntentSplit};
use crate::ext::Ext;
use crate::state::{
    Announcement, ClaimBoard, Committee, Config, Intent, MintCap, CLAIMS_SEED, CONFIG_ADDRESS,
    CONFIG_VERSION, INTENT_VERSION, MINT_CAP_SEED, MINT_CAP_VERSION, VAULT_SEED,
};

#[event_cpi]
#[derive(Accounts)]
pub struct FillAttestedSplitCommittee<'info> {
    pub solver: Signer<'info>,
    #[account(
        address = CONFIG_ADDRESS,
        constraint = config.load()?.version == CONFIG_VERSION @ EngineError::AccountOutdated
    )]
    pub config: AccountLoader<'info, Config>,
    #[account(
        mut,
        has_one = input_mint,
        constraint = intent.load()?.version == INTENT_VERSION @ EngineError::AccountOutdated
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
        dup,
        address = get_associated_token_address_with_program_id(
            &intent.load()?.partner,
            &input_mint.key(),
            &input_token_program.key()
        ) @ EngineError::PartnerAccountNotCanonical
    )]
    pub partner_to: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(mut, token::mint = input_mint, token::token_program = input_token_program)]
    pub judge_to: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(mut, token::mint = input_mint, token::token_program = input_token_program)]
    pub recipient0: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(mut, token::mint = input_mint, token::token_program = input_token_program)]
    pub recipient1: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(mut, token::mint = input_mint, token::token_program = input_token_program)]
    pub recipient2: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(mut, token::mint = input_mint, token::token_program = input_token_program)]
    pub recipient3: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(mut, token::mint = input_mint, token::token_program = input_token_program)]
    pub recipient4: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(mut, token::mint = input_mint, token::token_program = input_token_program)]
    pub recipient5: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(mut, token::mint = input_mint, token::token_program = input_token_program)]
    pub recipient6: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(mut, token::mint = input_mint, token::token_program = input_token_program)]
    pub recipient7: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub committee: AccountLoader<'info, Committee>,
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
        constraint = mint_cap.load()?.version == MINT_CAP_VERSION @ EngineError::AccountOutdated
    )]
    pub mint_cap: Option<AccountLoader<'info, MintCap>>,
    #[account(mut)]
    pub announcement: AccountLoader<'info, Announcement>,
}

pub fn handle_fill_attested_split_committee(
    mut ctx: Context<FillAttestedSplitCommittee>,
    fill: Fill,
    signers: u8,
    claim: SplitClaim,
    opening: Opening,
    ext: Ext,
) -> Result<()> {
    let judge = Judge::committee(&ctx.accounts.committee, signers)?;
    let accounts = &mut ctx.accounts;
    let recipients = [
        accounts.recipient0.as_ref().map(|a| a.to_account_info()),
        accounts.recipient1.as_ref().map(|a| a.to_account_info()),
        accounts.recipient2.as_ref().map(|a| a.to_account_info()),
        accounts.recipient3.as_ref().map(|a| a.to_account_info()),
        accounts.recipient4.as_ref().map(|a| a.to_account_info()),
        accounts.recipient5.as_ref().map(|a| a.to_account_info()),
        accounts.recipient6.as_ref().map(|a| a.to_account_info()),
        accounts.recipient7.as_ref().map(|a| a.to_account_info()),
    ];
    let split = release_split(
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
            announcement: Some(&accounts.announcement),
        },
        &recipients,
        &judge,
        fill,
        &claim,
        &opening,
        &ext,
    )?;
    let intent = ctx.accounts.intent.key();
    let solver = ctx.accounts.solver.key();
    let SplitReleased {
        released:
            Released {
                owner,
                attestor,
                signers,
                tally,
                fees,
                withheld,
                stake,
                delivered,
            },
        recipients,
        split_hash,
    } = split;
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
    if let Some(d) = delivered {
        emit_cpi!(DeliveryReleased {
            intent,
            announcement: d.announcement,
            seq: d.seq,
            worker: d.worker,
            attestor,
            delivered: d.opening.delivered,
            salt: d.opening.salt,
            split_hash,
        });
    }
    emit_cpi!(IntentSplit {
        intent,
        owner,
        solver,
        attestor,
        amount_in: tally.amount_in,
        result: fill.result,
        fee: fees.protocol,
        net: fees.net,
        partner_fee: fees.partner,
        recipients,
        split_hash,
    });
    emit_cpi!(CommitteeAttested {
        intent,
        committee: attestor,
        signers,
    });
    Ok(())
}
