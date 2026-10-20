use anchor_lang::prelude::*;
use anchor_lang::system_program::{allocate, assign, Allocate, Assign};
use anchor_lang::Discriminator;
use anchor_spl::token_interface::TokenAccount;
use intent_core::mint_cap::{
    charge, give_back_since, refund_outstanding, take_back, Limits, Refusal, Usage,
};

use crate::errors::EngineError;
use crate::policy::charge_lamports;
use crate::state::{Config, Intent, MintCap, MINT_CAP_SEED, MINT_CAP_VERSION, MIN_CAP_WINDOW_SECS};
use crate::versions::readable;
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
        EngineError::AccountOutdated
    );
    Ok(cap)
}

fn refused(refusal: Refusal) -> Error {
    match refusal {
        Refusal::PerOrder => error!(EngineError::MintCapPerOrder),
        Refusal::Window => error!(EngineError::MintCapWindow),
        Refusal::Total => error!(EngineError::MintCapTotal),
        Refusal::Overflow => EngineError::Overflow.into(),
    }
}

pub fn take_from_window(cap: &mut MintCap, amount: u64, now: i64) -> Result<()> {
    let limits = Limits {
        max_per_order: cap.max_per_order,
        window_cap: cap.window_cap,
        window_secs: cap.window_secs,
        total_limit: cap.total_limit,
    };
    let usage = Usage {
        window_start: cap.window_start,
        window_used: cap.window_used,
        outstanding: cap.outstanding,
    };
    let next = charge(limits, usage, amount, now).map_err(refused)?;
    cap.window_start = next.window_start;
    cap.window_used = next.window_used;
    cap.outstanding = next.outstanding;
    Ok(())
}

pub fn refund_mint_cap(
    mint_cap: Option<&AccountInfo>,
    intent: &AccountLoader<Intent>,
    left: u64,
) -> Result<u64> {
    let mut held = intent.load_mut()?;
    if left == 0 || held.capped == 0 {
        return Ok(0);
    }
    let cap = mint_cap.ok_or(EngineError::MintCapMissing)?;
    let mint = held.input_mint;
    let created_at = held.created_at;
    let (counted, capped) = take_back(held.capped, left);
    held.capped = capped;
    if *cap.owner == crate::ID {
        let mut data = cap.try_borrow_mut_data()?;
        if readable(&data) && data.get(..8) == Some(MintCap::DISCRIMINATOR) {
            let stored = cap_body(&mut data)?;
            let derived = Pubkey::create_program_address(
                &[MINT_CAP_SEED, mint.as_ref(), &[stored.bump]],
                &crate::ID,
            )
            .map_err(|_| error!(EngineError::MintCapMismatch))?;
            require_keys_eq!(*cap.key, derived, EngineError::MintCapMismatch);
            require_keys_eq!(stored.mint, mint, EngineError::MintCapMismatch);
            stored.outstanding =
                refund_outstanding(stored.outstanding, counted, stored.created_at, created_at);
            return Ok(counted);
        }
    }
    let derived = Pubkey::find_program_address(&[MINT_CAP_SEED, mint.as_ref()], &crate::ID).0;
    require_keys_eq!(*cap.key, derived, EngineError::MintCapMismatch);
    Ok(counted)
}

pub fn give_back(cap: &mut MintCap, intent: &mut Intent, left: u64) -> Result<u64> {
    let returned = give_back_since(
        cap.outstanding,
        intent.capped,
        left,
        cap.created_at,
        intent.created_at,
    )
    .map_err(refused)?;
    cap.outstanding = returned.outstanding;
    intent.capped = returned.capped;
    Ok(returned.counted)
}

pub fn charge_mint_cap(
    config: &AccountLoader<Config>,
    mint_cap: Option<&AccountLoader<MintCap>>,
    intent: &AccountLoader<Intent>,
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
    take_from_window(&mut cap, amount, now)?;
    intent.load_init()?.capped = amount;
    Ok(())
}

pub fn release_mint_cap(
    mint_cap: Option<&AccountLoader<MintCap>>,
    intent: &AccountLoader<Intent>,
    left: u64,
) -> Result<u64> {
    let mut held = intent.load_mut()?;
    if left == 0 || held.capped == 0 {
        return Ok(0);
    }
    let mint_cap = mint_cap.ok_or(EngineError::MintCapMissing)?;
    let mut cap = mint_cap.load_mut()?;
    require_keys_eq!(cap.mint, held.input_mint, EngineError::MintCapMismatch);
    give_back(&mut cap, &mut held, left)
}

pub fn settle_mint_cap(
    vault: &mut InterfaceAccount<TokenAccount>,
    before: u64,
    mint_cap: Option<&AccountLoader<MintCap>>,
    intent: &AccountLoader<Intent>,
) -> Result<u64> {
    if intent.load()?.capped == 0 {
        return Ok(0);
    }
    vault.reload()?;
    let left = before
        .checked_sub(vault.amount)
        .ok_or(EngineError::Overflow)?;
    release_mint_cap(mint_cap, intent, left)
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
    fresh.created_at = now;
    Ok(())
}
