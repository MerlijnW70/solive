use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use intent_core::fee::release_settles;
use intent_core::kinds::{Intent as CoreIntent, Kind};
use intent_core::lifecycle::Status;

use crate::errors::{core_err, EngineError};
use crate::events::AccountMigrated;
use crate::policy::{charge_lamports, FeeSchedule};
use crate::state::{ClaimBoard, Config, Intent, CONFIG_ADDRESS};
use crate::versions::{board_terms, config_terms, is_current, migration_of, Layout};

#[event_cpi]
#[derive(Accounts)]
pub struct Migrate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: any account this program owns, rewritten only from a layout listed in versions.rs
    #[account(mut, owner = crate::ID)]
    pub account: UncheckedAccount<'info>,
    /// CHECK: the config in its current or an earlier layout, read by hand for the fee schedule an open intent keeps
    #[account(address = CONFIG_ADDRESS)]
    pub config: Option<UncheckedAccount<'info>>,
    pub system_program: Program<'info, System>,
}

#[derive(Clone, Copy)]
struct Fee {
    bps: u16,
    dropped: bool,
}

fn is_type(layout: &Layout, discriminator: &[u8]) -> bool {
    layout.discriminator == discriminator
}

fn schedule(config: Option<&UncheckedAccount>) -> Result<FeeSchedule> {
    let config = config.ok_or(EngineError::ConfigMissing)?;
    let data = config.try_borrow_data()?;
    let terms = config_terms(&data).ok_or(EngineError::ConfigMissing)?;
    Ok(FeeSchedule::of(&terms))
}

fn settles(intent: &Intent, fee_bps: u16) -> Result<bool> {
    if Kind::try_from(intent.kind).map_err(core_err)? != Kind::AttestedResult {
        return Ok(true);
    }
    let decoded = CoreIntent::decode(intent.kind, &intent.params).map_err(core_err)?;
    Ok(release_settles(
        decoded.escrow_amount(),
        decoded.judge_fee(),
        fee_bps,
        intent.partner_bps,
        intent.partner_cut_bps,
    ))
}

fn intent_fee(data: &[u8], config: Option<&UncheckedAccount>) -> Result<Option<Fee>> {
    let body = data
        .get(Intent::DISCRIMINATOR.len()..Intent::SPACE)
        .ok_or(EngineError::UnknownLayout)?;
    let intent: &Intent =
        bytemuck::try_from_bytes(body).map_err(|_| error!(EngineError::UnknownLayout))?;
    if intent.status != Status::Open as u8 || intent.fee_bps != 0 {
        return Ok(None);
    }
    let bps = schedule(config)?.fee_bps(intent.kind)?;
    Ok(Some(if settles(intent, bps)? {
        Fee {
            bps,
            dropped: false,
        }
    } else {
        Fee {
            bps: 0,
            dropped: true,
        }
    }))
}

fn write_fee(data: &mut [u8], fee_bps: u16) -> Result<()> {
    let body = data
        .get_mut(Intent::DISCRIMINATOR.len()..Intent::SPACE)
        .ok_or(EngineError::UnknownLayout)?;
    let intent: &mut Intent =
        bytemuck::try_from_bytes_mut(body).map_err(|_| error!(EngineError::UnknownLayout))?;
    intent.fee_bps = fee_bps;
    Ok(())
}

fn top_up_for(lamports: u64, held: u64, from: usize, to: usize) -> Result<u64> {
    let rent = Rent::get()?;
    let new_min = rent.minimum_balance(to);
    let grown = lamports.saturating_add(new_min.saturating_sub(rent.minimum_balance(from)));
    let target = grown.max(new_min.saturating_add(held));
    Ok(target.saturating_sub(lamports))
}

pub fn handle_migrate(ctx: Context<Migrate>) -> Result<()> {
    let account = ctx.accounts.account.to_account_info();
    let (layout, from, fee, held) = {
        let data = account.try_borrow_data()?;
        require!(!is_current(&data), EngineError::AlreadyCurrent);
        let (layout, from) = migration_of(&data).ok_or(EngineError::UnknownLayout)?;
        if is_type(layout, Config::DISCRIMINATOR) {
            let admin = config_terms(&data).ok_or(EngineError::UnknownLayout)?.admin;
            require_keys_eq!(ctx.accounts.payer.key(), admin, EngineError::Unauthorized);
        }
        let fee = if is_type(layout, Intent::DISCRIMINATOR) {
            intent_fee(&data, ctx.accounts.config.as_ref())?
        } else {
            None
        };
        let held = if is_type(layout, ClaimBoard::DISCRIMINATOR) {
            board_terms(&data).map_or(0, |t| t.held)
        } else {
            0
        };
        (layout, *from, fee, held)
    };
    let mut top_up = 0;
    if from.space < layout.space {
        top_up = top_up_for(account.lamports(), held, from.space, layout.space)?;
        charge_lamports(
            &ctx.accounts.system_program,
            ctx.accounts.payer.to_account_info(),
            account.clone(),
            top_up,
        )?;
        account.resize(layout.space)?;
    }
    {
        let mut data = account.try_borrow_mut_data()?;
        let at = layout
            .discriminator
            .len()
            .checked_add(layout.version_at)
            .ok_or(EngineError::Overflow)?;
        *data.get_mut(at).ok_or(EngineError::UnknownLayout)? = layout.version;
        if let Some(fee) = fee {
            write_fee(&mut data, fee.bps)?;
        }
    }
    emit_cpi!(AccountMigrated {
        account: account.key(),
        from_version: from.version,
        version: layout.version,
        from_space: u32::try_from(from.space).map_err(|_| error!(EngineError::Overflow))?,
        space: u32::try_from(layout.space).map_err(|_| error!(EngineError::Overflow))?,
        top_up,
        fee_bps: fee.map_or(0, |f| f.bps),
        fee_dropped: fee.is_some_and(|f| f.dropped),
    });
    Ok(())
}
