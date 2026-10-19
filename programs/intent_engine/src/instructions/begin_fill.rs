use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT};
use anchor_lang::Discriminator;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use intent_core::ext::FILL_EXT_TAGS;
use intent_core::flash::check_flash_end;
use intent_core::kinds::Intent as CoreIntent;
use intent_core::lifecycle::{transition, Action, Status};
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

use crate::caps::settle_mint_cap;
use crate::errors::{core_err, EngineError};
use crate::events::{AgentPaid, FeeWithheld, FillBegun, WITHHELD_AGENT, WITHHELD_PARTNER};
use crate::ext::Ext;
use crate::policy::{
    check_fill_kind, check_mandate_live, check_mint, pay_agent, pay_out, take_remaining,
    AgentPayout, FeeTerms, IntentSigner, Payout,
};
use crate::state::{
    Config, Intent, MintCap, UserState, CONFIG_ADDRESS, CONFIG_VERSION, INTENT_VERSION,
    MINT_CAP_SEED, MINT_CAP_VERSION, PAUSE_FILL, VAULT_SEED,
};

pub const END_FILL_INTENT_INDEX: usize = 0;

#[event_cpi]
#[derive(Accounts)]
pub struct BeginFill<'info> {
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
    /// CHECK: read only through the checked instructions-sysvar loader
    pub instructions: UncheckedAccount<'info>,
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
        constraint = mint_cap.load()?.version == MINT_CAP_VERSION @ EngineError::AccountOutdated
    )]
    pub mint_cap: Option<AccountLoader<'info, MintCap>>,
}

pub fn handle_begin_fill(
    ctx: Context<BeginFill>,
    amount_in: u64,
    end_index: u16,
    max_fee_bps: u16,
    ext: Ext,
) -> Result<()> {
    ext.check(FILL_EXT_TAGS)?;
    require!(
        get_stack_height() == TRANSACTION_LEVEL_STACK_HEIGHT,
        EngineError::FlashCpi
    );
    let now = Clock::get()?.unix_timestamp;
    let disabled = {
        let config = ctx.accounts.config.load()?;
        require!(config.paused & PAUSE_FILL == 0, EngineError::FillPaused);
        config.fill_disabled_kinds
    };
    check_mint(&ctx.accounts.input_mint.to_account_info())?;
    let intent_key = ctx.accounts.intent.key();
    let before_vault = ctx.accounts.vault.amount;
    let current = load_current_index_checked(&ctx.accounts.instructions.to_account_info())?;
    require!(end_index > current, EngineError::FlashEndOrder);
    let row = load_instruction_at_checked(
        usize::from(end_index),
        &ctx.accounts.instructions.to_account_info(),
    )?;
    check_flash_end(
        &row.program_id.to_bytes(),
        &row.data,
        row.accounts
            .get(END_FILL_INTENT_INDEX)
            .map(|meta| meta.pubkey.to_bytes())
            .as_ref(),
        &crate::ID.to_bytes(),
        crate::instruction::EndFill::DISCRIMINATOR,
        &intent_key.to_bytes(),
    )
    .map_err(core_err)?;
    let (tally, signer, terms, agent) = {
        let mut intent = ctx.accounts.intent.load_mut()?;
        check_fill_kind(intent.kind, disabled)?;
        check_mandate_live(
            &intent,
            ctx.accounts.mandate.as_deref(),
            ctx.accounts.owner_state.as_ref(),
        )?;
        let terms = FeeTerms::recorded(&intent);
        let status = Status::try_from(intent.status).map_err(core_err)?;
        let next = transition(status, Action::Begin, now, intent.expires_at)
            .map_err(core_err)?
            .ok_or(EngineError::InvalidTransition)?;
        intent.status = next as u8;
        let tally = take_remaining(&mut intent, amount_in)?;
        intent.in_flight = tally.amount_in;
        CoreIntent::decode(intent.kind, &intent.params)
            .and_then(|decoded| decoded.required_out(tally.amount_in, now))
            .map_err(core_err)?;
        let signer = IntentSigner {
            owner: intent.owner,
            nonce: intent.nonce.to_le_bytes(),
            bump: [intent.bump],
        };
        let agent = (intent.rent_payer, intent.agent_fee);
        intent.agent_fee = 0;
        (tally, signer, terms, agent)
    };
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
            intent: intent_key,
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
            intent: intent_key,
            agent: agent.0,
            account,
            fee: agent.1,
        }),
        Some(AgentPayout {
            account,
            paid: false,
        }) => emit_cpi!(FeeWithheld {
            intent: intent_key,
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
    emit_cpi!(FillBegun {
        intent: intent_key,
        solver: ctx.accounts.solver.key(),
        solver_input: ctx.accounts.solver_input.key(),
        end_index,
        amount_in: tally.amount_in,
        fee: fees.protocol,
        net: fees.net,
        filled: tally.filled,
        remaining: tally.remaining,
        partner_fee: fees.partner,
    });
    Ok(())
}
