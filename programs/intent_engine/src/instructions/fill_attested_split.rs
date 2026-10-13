use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use intent_core::ext::FILL_EXT_TAGS;
use intent_core::kinds::Intent as CoreIntent;
use intent_core::lifecycle::{transition, Action, Status};
use intent_core::sig::{offchain_envelope, AttestedSplit};

use crate::errors::{core_err, EngineError};
use crate::events::{FeeWithheld, IntentSplit, WITHHELD_JUDGE, WITHHELD_PARTNER};
use crate::ext::Ext;
use crate::policy::{
    check_fill_kind, check_mint, pay_agent, pay_out_split, take_remaining,
    verify_preceding_ed25519, AgentPayout, FeeSchedule, IntentSigner, SplitPayout,
};
use crate::state::{
    Config, Intent, CONFIG_ADDRESS, CONFIG_VERSION, INTENT_VERSION, PAUSE_FILL, VAULT_SEED,
};

pub const MAX_SPLIT_RECIPIENTS: usize = 8;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SplitClaim {
    pub recipients: Vec<Pubkey>,
    pub weights: Vec<u16>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct FillAttestedSplit<'info> {
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
    pub input_token_program: Interface<'info, TokenInterface>,
    /// CHECK: read only through the checked instructions-sysvar loaders
    pub instructions: UncheckedAccount<'info>,
}

pub fn handle_fill_attested_split(
    ctx: Context<FillAttestedSplit>,
    amount_in: u64,
    result: u64,
    max_fee_bps: u16,
    claim: SplitClaim,
    ext: Ext,
) -> Result<()> {
    ext.check(FILL_EXT_TAGS)?;
    let len = claim.recipients.len();
    require!(
        len > 0 && len <= MAX_SPLIT_RECIPIENTS,
        EngineError::SplitCountMismatch
    );
    require!(claim.weights.len() == len, EngineError::SplitCountMismatch);
    let slots = [
        ctx.accounts
            .recipient0
            .as_ref()
            .map(|a| a.to_account_info()),
        ctx.accounts
            .recipient1
            .as_ref()
            .map(|a| a.to_account_info()),
        ctx.accounts
            .recipient2
            .as_ref()
            .map(|a| a.to_account_info()),
        ctx.accounts
            .recipient3
            .as_ref()
            .map(|a| a.to_account_info()),
        ctx.accounts
            .recipient4
            .as_ref()
            .map(|a| a.to_account_info()),
        ctx.accounts
            .recipient5
            .as_ref()
            .map(|a| a.to_account_info()),
        ctx.accounts
            .recipient6
            .as_ref()
            .map(|a| a.to_account_info()),
        ctx.accounts
            .recipient7
            .as_ref()
            .map(|a| a.to_account_info()),
    ];
    let mut recipients_info = Vec::with_capacity(len);
    for (i, slot) in slots.iter().enumerate() {
        require!(slot.is_some() == (i < len), EngineError::SplitCountMismatch);
        if let Some(info) = slot {
            recipients_info.push(info.clone());
        }
    }
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
    let (attestor, tally, prior, signer, terms, spec_hash, judge_fee) = {
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
        let decoded = CoreIntent::decode(intent.kind, &intent.params).map_err(core_err)?;
        let attestor = decoded
            .check_attested(tally.amount_in, result)
            .map_err(core_err)?;
        let spec_hash = decoded.spec_hash();
        let judge_fee = decoded.judge_fee();
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
            spec_hash,
            judge_fee,
        )
    };
    require!(spec_hash != [0u8; 32], EngineError::NotAProof);
    let split_hash = {
        let mut buf = Vec::with_capacity(len.saturating_mul(34));
        for (wallet, bps) in claim.recipients.iter().zip(claim.weights.iter()) {
            buf.extend_from_slice(wallet.as_ref());
            buf.extend_from_slice(&bps.to_le_bytes());
        }
        solana_sha256_hasher::hashv(&[&buf]).to_bytes()
    };
    let ext_hash = solana_sha256_hasher::hashv(&[&ext.0]).to_bytes();
    let digest = {
        let preimage = AttestedSplit {
            program: crate::ID.to_bytes(),
            domain,
            intent: ctx.accounts.intent.key().to_bytes(),
            amount_in: tally.amount_in,
            result,
            filled: prior.0,
            revision: prior.1,
            max_fee_bps,
            ext_hash,
            spec_hash,
            split_hash,
        }
        .preimage();
        solana_sha256_hasher::hashv(&[&preimage]).to_bytes()
    };
    verify_preceding_ed25519(
        &ctx.accounts.instructions.to_account_info(),
        &attestor,
        &offchain_envelope(&attestor.to_bytes(), &digest),
    )?;
    for (wallet, info) in claim.recipients.iter().zip(recipients_info.iter()) {
        let canonical = get_associated_token_address_with_program_id(
            wallet,
            &ctx.accounts.input_mint.key(),
            &ctx.accounts.input_token_program.key(),
        );
        require!(info.key() == canonical, EngineError::RecipientNotCanonical);
    }
    let settle_amount = tally
        .amount_in
        .checked_sub(judge_fee)
        .ok_or(EngineError::Overflow)?;
    if judge_fee > 0 {
        let judge_to = ctx
            .accounts
            .judge_to
            .as_deref()
            .ok_or(EngineError::FeeAccountMissing)?;
        let canonical = get_associated_token_address_with_program_id(
            &attestor,
            &ctx.accounts.input_mint.key(),
            &ctx.accounts.input_token_program.key(),
        );
        require!(
            judge_to.key() == canonical,
            EngineError::FeeAccountNotCanonical
        );
        if let Some(AgentPayout {
            account,
            paid: false,
        }) = pay_agent(
            &ctx.accounts.input_token_program,
            &ctx.accounts.vault,
            &ctx.accounts.input_mint,
            Some(judge_to),
            ctx.accounts.intent.to_account_info(),
            &signer,
            (attestor, judge_fee),
        )? {
            emit_cpi!(FeeWithheld {
                intent: ctx.accounts.intent.key(),
                payee: attestor,
                account,
                fee: judge_fee,
                role: WITHHELD_JUDGE,
            });
        }
    }
    let settled = pay_out_split(
        SplitPayout {
            token_program: &ctx.accounts.input_token_program,
            vault: &ctx.accounts.vault,
            mint: &ctx.accounts.input_mint,
            fee_to: ctx.accounts.fee_to.as_deref(),
            partner_to: ctx.accounts.partner_to.as_deref(),
            recipients: &recipients_info,
            intent: ctx.accounts.intent.to_account_info(),
            signer: &signer,
        },
        settle_amount,
        terms,
        max_fee_bps,
        &claim.weights,
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
    ctx.accounts.vault.reload()?;
    require!(
        ctx.accounts.vault.amount == 0,
        EngineError::SplitNotConserved
    );
    let recipients = u8::try_from(len).map_err(|_| EngineError::SplitCountMismatch)?;
    emit_cpi!(IntentSplit {
        intent: ctx.accounts.intent.key(),
        owner: signer.owner,
        solver: ctx.accounts.solver.key(),
        attestor,
        amount_in: tally.amount_in,
        result,
        fee: fees.protocol,
        net: fees.net,
        partner_fee: fees.partner,
        recipients,
        split_hash,
    });
    Ok(())
}
