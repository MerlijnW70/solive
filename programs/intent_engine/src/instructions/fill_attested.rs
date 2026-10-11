use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use intent_core::ext::FILL_EXT_TAGS;
use intent_core::kinds::Intent as CoreIntent;
use intent_core::lifecycle::{transition, Action, Status};
use intent_core::sig::{offchain_envelope, AttestedFill};

use crate::errors::{core_err, EngineError};
use crate::events::{FeeWithheld, IntentAttested, WITHHELD_PARTNER};
use crate::ext::Ext;
use crate::policy::{
    check_fill_kind, check_mint, pay_out, take_remaining, verify_preceding_ed25519, FeeSchedule,
    IntentSigner, Payout,
};
use crate::state::{
    Config, Intent, CONFIG_ADDRESS, CONFIG_VERSION, INTENT_VERSION, PAUSE_FILL, VAULT_SEED,
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
    pub input_token_program: Interface<'info, TokenInterface>,
    /// CHECK: read only through the checked instructions-sysvar loaders
    pub instructions: UncheckedAccount<'info>,
}

pub fn handle_fill_attested(
    ctx: Context<FillAttested>,
    amount_in: u64,
    result: u64,
    max_fee_bps: u16,
    ext: Ext,
) -> Result<()> {
    ext.check(FILL_EXT_TAGS)?;
    let now = Clock::get()?.unix_timestamp;
    let (schedule, domain, disabled) = {
        let config = ctx.accounts.config.load()?;
        require!(config.paused & PAUSE_FILL == 0, EngineError::FillPaused);
        (
            FeeSchedule::of(&config),
            config.domain,
            config.fill_disabled_kinds,
        )
    };
    check_mint(&ctx.accounts.input_mint.to_account_info())?;
    let (attestor, tally, prior, signer, terms) = {
        let mut intent = ctx.accounts.intent.load_mut()?;
        check_fill_kind(intent.kind, disabled)?;
        require!(intent.agent_fee == 0, EngineError::MandateMismatch);
        let terms = schedule.terms(&intent)?;
        let status = Status::try_from(intent.status).map_err(core_err)?;
        let next = transition(status, Action::Fill, now, intent.expires_at)
            .map_err(core_err)?
            .ok_or(EngineError::InvalidTransition)?;
        intent.status = next as u8;
        let prior = (intent.filled, intent.revision);
        let tally = take_remaining(&mut intent, amount_in)?;
        let attestor = CoreIntent::decode(intent.kind, &intent.params)
            .and_then(|decoded| decoded.check_attested(tally.amount_in, result))
            .map_err(core_err)?;
        let signer = IntentSigner {
            owner: intent.owner,
            nonce: intent.nonce.to_le_bytes(),
            bump: [intent.bump],
        };
        (
            Pubkey::new_from_array(attestor),
            tally,
            prior,
            signer,
            terms,
        )
    };
    let preimage = AttestedFill {
        program: crate::ID.to_bytes(),
        domain,
        intent: ctx.accounts.intent.key().to_bytes(),
        payee: ctx.accounts.payee.key().to_bytes(),
        amount_in: tally.amount_in,
        result,
        filled: prior.0,
        revision: prior.1,
        max_fee_bps,
        ext_hash: solana_sha256_hasher::hashv(&[&ext.0]).to_bytes(),
    }
    .preimage();
    let digest = solana_sha256_hasher::hashv(&[&preimage]).to_bytes();
    verify_preceding_ed25519(
        &ctx.accounts.instructions.to_account_info(),
        &attestor,
        &offchain_envelope(&attestor.to_bytes(), &digest),
    )?;
    let settled = pay_out(
        Payout {
            token_program: &ctx.accounts.input_token_program,
            vault: &ctx.accounts.vault,
            mint: &ctx.accounts.input_mint,
            fee_to: ctx.accounts.fee_to.as_deref(),
            partner_to: ctx.accounts.partner_to.as_deref(),
            payee: ctx.accounts.payee.to_account_info(),
            intent: ctx.accounts.intent.to_account_info(),
            signer: &signer,
        },
        tally.amount_in,
        terms,
        max_fee_bps,
    )?;
    let fees = settled.fees;
    if let Some((account, fee)) = settled.withheld {
        emit_cpi!(FeeWithheld {
            intent: ctx.accounts.intent.key(),
            payee: terms.partner,
            account,
            fee,
            role: WITHHELD_PARTNER,
        });
    }
    emit_cpi!(IntentAttested {
        intent: ctx.accounts.intent.key(),
        owner: signer.owner,
        solver: ctx.accounts.solver.key(),
        payee: ctx.accounts.payee.key(),
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
