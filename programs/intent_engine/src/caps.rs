use anchor_lang::prelude::*;
use anchor_lang::system_program::{allocate, assign, Allocate, Assign};
use anchor_lang::Discriminator;

use crate::errors::EngineError;
use crate::policy::charge_lamports;
use crate::state::{Config, MintCap, MINT_CAP_SEED, MINT_CAP_VERSION, MIN_CAP_WINDOW_SECS};
pub fn check_limits(max_per_order: u64, window_cap: u64, window_secs: u32) -> Result<()> {
    require!(
        max_per_order > 0 && window_cap >= max_per_order && window_secs >= MIN_CAP_WINDOW_SECS,
        EngineError::MintCapInvalid
    );
    Ok(())
}

fn cap_body(data: &mut [u8]) -> Result<&mut MintCap> {
    let body = data
        .get_mut(8..MintCap::SPACE)
        .ok_or(EngineError::MintCapMismatch)?;
    bytemuck::try_from_bytes_mut(body).map_err(|_| error!(EngineError::MintCapMismatch))
}

pub fn cap_in(data: &mut [u8]) -> Result<&mut MintCap> {
    require!(
        data.get(..8) == Some(MintCap::DISCRIMINATOR),
        EngineError::MintCapMismatch
    );
    let cap = cap_body(data)?;
    require!(
        cap.version == MINT_CAP_VERSION,
        EngineError::UnsupportedVersion
    );
    Ok(cap)
}

pub fn take_from_window(cap: &mut MintCap, amount: u64, now: i64) -> Result<()> {
    require!(amount <= cap.max_per_order, EngineError::MintCapPerOrder);
    let ends = cap
        .window_start
        .checked_add(i64::from(cap.window_secs))
        .ok_or(EngineError::Overflow)?;
    if now >= ends {
        cap.window_start = now;
        cap.window_used = 0;
    }
    let used = cap
        .window_used
        .checked_add(amount)
        .ok_or(EngineError::Overflow)?;
    require!(used <= cap.window_cap, EngineError::MintCapWindow);
    cap.window_used = used;
    Ok(())
}

pub fn charge_mint_cap(
    config: &AccountLoader<Config>,
    mint_cap: Option<&AccountLoader<MintCap>>,
    mint: &Pubkey,
    amount: u64,
    now: i64,
) -> Result<()> {
    if config.load()?.caps_required == 0 {
        return Ok(());
    }
    let mint_cap = mint_cap.ok_or(EngineError::MintCapMissing)?;
    let mut cap = mint_cap.load_mut()?;
    require_keys_eq!(cap.mint, *mint, EngineError::MintCapMismatch);
    take_from_window(&mut cap, amount, now)
}

pub fn open_mint_cap<'info>(
    system_program: &Program<'info, System>,
    payer: AccountInfo<'info>,
    cap: AccountInfo<'info>,
    mint: &Pubkey,
    bump: u8,
    now: i64,
) -> Result<()> {
    let space = u64::try_from(MintCap::SPACE).map_err(|_| error!(EngineError::Overflow))?;
    let rent = Rent::get()?.minimum_balance(MintCap::SPACE);
    charge_lamports(
        system_program,
        payer,
        cap.clone(),
        rent.saturating_sub(cap.lamports()),
    )?;
    let bump_seed = [bump];
    let seeds: &[&[u8]] = &[MINT_CAP_SEED, mint.as_ref(), &bump_seed];
    allocate(
        CpiContext::new_with_signer(
            system_program.key(),
            Allocate {
                account_to_allocate: cap.clone(),
            },
            &[seeds],
        ),
        space,
    )?;
    assign(
        CpiContext::new_with_signer(
            system_program.key(),
            Assign {
                account_to_assign: cap.clone(),
            },
            &[seeds],
        ),
        &crate::ID,
    )?;
    let mut data = cap.try_borrow_mut_data()?;
    data.get_mut(..8)
        .ok_or(EngineError::MintCapMismatch)?
        .copy_from_slice(MintCap::DISCRIMINATOR);
    let fresh = cap_body(&mut data)?;
    fresh.mint = *mint;
    fresh.version = MINT_CAP_VERSION;
    fresh.bump = bump;
    fresh.window_start = now;
    Ok(())
}
