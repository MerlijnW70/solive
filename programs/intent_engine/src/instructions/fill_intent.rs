use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use intent_core::ext::FILL_EXT_TAGS;
use intent_core::kinds::Intent as CoreIntent;
use intent_core::lifecycle::{transition, Action, Status};

use crate::caps::settle_mint_cap;
use crate::errors::{core_err, EngineError};
use crate::events::{AgentPaid, FeeWithheld, IntentFilled, WITHHELD_AGENT, WITHHELD_PARTNER};
use crate::ext::Ext;
use crate::policy::{
    check_fill_kind, check_mandate_live, check_mint, deliver, pay_agent, pay_out, take_remaining,
    AgentPayout, FeeTerms, IntentSigner, Payout,
};
use crate::state::{
    Config, Intent, MintCap, UserState, CONFIG_ADDRESS, CONFIG_VERSION, INTENT_VERSION,
    MINT_CAP_SEED, MINT_CAP_VERSION, PAUSE_FILL, VAULT_SEED,
};

#[event_cpi]
#[derive(Accounts)]
pub struct FillIntent<'info> {
    pub solver: Signer<'info>,
    #[account(
        address = CONFIG_ADDRESS,
        constraint = config.load()?.version == CONFIG_VERSION @ EngineError::UnsupportedVersion
    )]
    pub config: AccountLoader<'info, Config>,
    #[account(
        mut,
        has_one = input_mint, has_one = output_mint, has_one = receiver,
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
    /// CHECK: the token program checks it holds the input mint
    #[account(mut)]
    pub solver_input: UncheckedAccount<'info>,
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
    pub output_token_program: Interface<'info, TokenInterface>,
    /// CHECK: matched to the intent's mandate and loaded by check_mandate_live
    pub mandate: Option<UncheckedAccount<'info>>,
    #[account(
        constraint = owner_state.load()?.owner == intent.load()?.owner @ EngineError::MandateMismatch
    )]
    pub owner_state: Option<AccountLoader<'info, UserState>>,
    #[account(
        mut,
        address = get_associated_token_address_with_program_id(
            &intent.load()?.rent_payer,
            &input_mint.key(),
            &input_token_program.key()
        ) @ EngineError::FeeAccountNotCanonical
    )]
    pub agent_to: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    #[account(
        mut,
        seeds = [MINT_CAP_SEED, input_mint.key().as_ref()],
        bump = mint_cap.load()?.bump,
        constraint = mint_cap.load()?.version == MINT_CAP_VERSION @ EngineError::UnsupportedVersion
    )]
    pub mint_cap: Option<AccountLoader<'info, MintCap>>,
}

pub fn handle_fill_intent(
    ctx: Context<FillIntent>,
    amount_in: u64,
    amount_out: u64,
    max_fee_bps: u16,
    ext: Ext,
) -> Result<()> {
    ext.check(FILL_EXT_TAGS)?;
    let now = Clock::get()?.unix_timestamp;
    let disabled = {
        let config = ctx.accounts.config.load()?;
        require!(config.paused & PAUSE_FILL == 0, EngineError::FillPaused);
        config.fill_disabled_kinds
    };
    check_mint(&ctx.accounts.input_mint.to_account_info())?;
    check_mint(&ctx.accounts.output_mint.to_account_info())?;
    let before_vault = ctx.accounts.vault.amount;
    let (decoded, tally, signer, terms, agent) = {
        let mut intent = ctx.accounts.intent.load_mut()?;
        check_fill_kind(intent.kind, disabled)?;
        check_mandate_live(
            &intent,
            ctx.accounts.mandate.as_deref(),
            ctx.accounts.owner_state.as_ref(),
        )?;
        let terms = FeeTerms::recorded(&intent);
        let status = Status::try_from(intent.status).map_err(core_err)?;
        let next = transition(status, Action::Fill, now, intent.expires_at)
            .map_err(core_err)?
            .ok_or(EngineError::InvalidTransition)?;
        intent.status = next as u8;
        let tally = take_remaining(&mut intent, amount_in)?;
        let decoded = CoreIntent::decode(intent.kind, &intent.params).map_err(core_err)?;
        let signer = IntentSigner {
            owner: intent.owner,
            nonce: intent.nonce.to_le_bytes(),
            bump: [intent.bump],
        };
        let agent = (intent.rent_payer, intent.agent_fee);
        intent.agent_fee = 0;
        (decoded, tally, signer, terms, agent)
    };
    let required = decoded
        .required_out(tally.amount_in, now)
        .map_err(core_err)?;
    let (before, after) = deliver(
        &ctx.accounts.output_token_program,
        ctx.accounts.solver_output.to_account_info(),
        &ctx.accounts.output_mint,
        &mut ctx.accounts.receiver,
        ctx.accounts.solver.to_account_info(),
        amount_out,
    )?;
    let delivered = decoded
        .settle_delta(tally.amount_in, before, after, now)
        .map_err(core_err)?;
    let settled = pay_out(
        Payout {
            token_program: &ctx.accounts.input_token_program,
            vault: &ctx.accounts.vault,
            mint: &ctx.accounts.input_mint,
            fee_to: ctx.accounts.fee_to.as_deref(),
            partner_to: ctx.accounts.partner_to.as_deref(),
            payee: ctx.accounts.solver_input.to_account_info(),
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
    match pay_agent(
        &ctx.accounts.input_token_program,
        &ctx.accounts.vault,
        &ctx.accounts.input_mint,
        ctx.accounts.agent_to.as_deref(),
        ctx.accounts.intent.to_account_info(),
        &signer,
        agent,
    )? {
        Some(AgentPayout {
            account,
            paid: true,
        }) => emit_cpi!(AgentPaid {
            intent: ctx.accounts.intent.key(),
            agent: agent.0,
            account,
            fee: agent.1,
        }),
        Some(AgentPayout {
            account,
            paid: false,
        }) => emit_cpi!(FeeWithheld {
            intent: ctx.accounts.intent.key(),
            payee: agent.0,
            account,
            fee: agent.1,
            role: WITHHELD_AGENT,
        }),
        None => {}
    }
    settle_mint_cap(
        &mut ctx.accounts.vault,
        before_vault,
        ctx.accounts.mint_cap.as_ref(),
        &ctx.accounts.intent,
    )?;
    emit_cpi!(IntentFilled {
        intent: ctx.accounts.intent.key(),
        owner: signer.owner,
        solver: ctx.accounts.solver.key(),
        receiver: ctx.accounts.receiver.key(),
        solver_input: ctx.accounts.solver_input.key(),
        amount_in: tally.amount_in,
        delivered,
        required,
        fee: fees.protocol,
        net: fees.net,
        filled: tally.filled,
        remaining: tally.remaining,
        partner_fee: fees.partner,
    });
    Ok(())
}
