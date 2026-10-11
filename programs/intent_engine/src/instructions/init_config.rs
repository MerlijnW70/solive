use anchor_lang::prelude::*;

use crate::errors::EngineError;
use crate::events::ConfigInitialized;
use crate::policy::{validate_config, ConfigSettings};
use crate::program::IntentEngine;
use crate::state::{Config, CONFIG_SEED, CONFIG_VERSION};

#[event_cpi]
#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = Config::SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: AccountLoader<'info, Config>,
    #[account(
        constraint = engine_program.programdata_address()? == Some(program_data.key())
            @ EngineError::Unauthorized
    )]
    pub engine_program: Program<'info, IntentEngine>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ EngineError::Unauthorized
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_config(
    ctx: Context<InitConfig>,
    args: ConfigSettings,
    domain: [u8; 32],
) -> Result<()> {
    validate_config(&args)?;
    require!(domain != [0; 32], EngineError::InvalidDomain);
    let admin = ctx.accounts.authority.key();
    {
        let mut config = ctx.accounts.config.load_init()?;
        config.admin = admin;
        config.pending_admin = Pubkey::default();
        config.guardian = args.guardian;
        config.fee_recipient = args.fee_recipient;
        config.enabled_kinds = args.enabled_kinds;
        config.fee_bps = args.fee_bps;
        config.paused = args.paused;
        config.version = CONFIG_VERSION;
        config.bump = ctx.bumps.config;
        config.domain = domain;
    }
    emit_cpi!(ConfigInitialized {
        admin,
        domain,
        guardian: args.guardian,
        fee_recipient: args.fee_recipient,
        enabled_kinds: args.enabled_kinds,
        fee_bps: args.fee_bps,
        paused: args.paused,
    });
    Ok(())
}
