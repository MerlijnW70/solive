use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::caps::{cap_in, check_limits, open_mint_cap};
use crate::errors::EngineError;
use crate::events::MintCapSet;
use crate::state::{Config, CONFIG_ADDRESS, CONFIG_VERSION, MINT_CAP_SEED};

#[event_cpi]
#[derive(Accounts)]
pub struct SetMintCap<'info> {
    pub admin: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        address = CONFIG_ADDRESS,
        constraint = config.load()?.version == CONFIG_VERSION @ EngineError::UnsupportedVersion,
        has_one = admin @ EngineError::Unauthorized
    )]
    pub config: AccountLoader<'info, Config>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: the mint's cap; created here on first use, then read only through its discriminator
    #[account(mut, seeds = [MINT_CAP_SEED, mint.key().as_ref()], bump)]
    pub mint_cap: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_set_mint_cap(
    ctx: Context<SetMintCap>,
    max_per_order: u64,
    window_cap: u64,
    window_secs: u32,
    total_limit: u64,
) -> Result<()> {
    check_limits(max_per_order, window_cap, window_secs)?;
    let now = Clock::get()?.unix_timestamp;
    let mint = ctx.accounts.mint.key();
    let info = ctx.accounts.mint_cap.to_account_info();
    if *info.owner != crate::ID {
        open_mint_cap(
            &ctx.accounts.system_program,
            ctx.accounts.payer.to_account_info(),
            info.clone(),
            &mint,
            ctx.bumps.mint_cap,
            now,
        )?;
    }
    let (window_start, window_used, outstanding) = {
        let mut data = info.try_borrow_mut_data()?;
        let cap = cap_in(&mut data)?;
        cap.max_per_order = max_per_order;
        cap.window_cap = window_cap;
        cap.window_secs = window_secs;
        cap.total_limit = total_limit;
        (cap.window_start, cap.window_used, cap.outstanding)
    };
    emit_cpi!(MintCapSet {
        mint,
        mint_cap: info.key(),
        max_per_order,
        window_cap,
        window_secs,
        window_start,
        window_used,
        total_limit,
        outstanding,
    });
    Ok(())
}
