use anchor_lang::prelude::*;

use crate::errors::EngineError;
use crate::events::ConfigUpdated;
use crate::policy::{check_kind_bits, validate_terms, ConfigUpdate};
use crate::state::{Config, CONFIG_ADDRESS, CONFIG_VERSION};

#[event_cpi]
#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        address = CONFIG_ADDRESS,
        constraint = config.load()?.version == CONFIG_VERSION @ EngineError::AccountOutdated,
        has_one = admin @ EngineError::Unauthorized
    )]
    pub config: AccountLoader<'info, Config>,
}

pub fn handle_update_config(ctx: Context<UpdateConfig>, args: ConfigUpdate) -> Result<()> {
    validate_terms(args.enabled_kinds, args.fee_bps)?;
    check_kind_bits(args.fill_disabled_kinds)?;
    let paused = {
        let mut config = ctx.accounts.config.load_mut()?;
        config.guardian = args.guardian;
        config.fee_recipient = args.fee_recipient;
        config.enabled_kinds = args.enabled_kinds;
        config.fee_bps = args.fee_bps;
        config.fill_disabled_kinds = args.fill_disabled_kinds;
        config.paused
    };
    emit_cpi!(ConfigUpdated {
        guardian: args.guardian,
        fee_recipient: args.fee_recipient,
        enabled_kinds: args.enabled_kinds,
        fee_bps: args.fee_bps,
        paused,
        fill_disabled_kinds: args.fill_disabled_kinds,
    });
    Ok(())
}
