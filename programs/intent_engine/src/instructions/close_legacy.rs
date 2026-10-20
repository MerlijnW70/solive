use anchor_lang::prelude::*;
use intent_core::claim::{stake_on_settle, Slot, StakeTo};

use crate::claims::{close_entry, escrow_deadline, move_lamports};
use crate::errors::{core_err, EngineError};
use crate::events::LegacyClosed;
use crate::state::{Config, CONFIG_ADDRESS, CONFIG_VERSION, VAULT_SEED};
use crate::versions::{
    board_terms, is_current, is_intent, line_intent, migrates_in_place, readable, recorded_payer,
};

#[event_cpi]
#[derive(Accounts)]
pub struct CloseLegacy<'info> {
    /// CHECK: any account this program owns, closed only when no current account type and version describes it
    #[account(mut, owner = crate::ID)]
    pub account: UncheckedAccount<'info>,
    /// CHECK: the wallet the account's layout records as its payer, or else the config's fee recipient
    #[account(mut)]
    pub payee: UncheckedAccount<'info>,
    #[account(
        address = CONFIG_ADDRESS,
        constraint = config.load()?.version == CONFIG_VERSION @ EngineError::AccountOutdated
    )]
    pub config: Option<AccountLoader<'info, Config>>,
    /// CHECK: an intent's vault, checked against the address its intent derives; an intent closes only once its vault is no live token account
    pub vault: Option<UncheckedAccount<'info>>,
    /// CHECK: a claim board's or stand-by entry's escrow, read only to learn whether it is still open, as settle_claims does
    pub intent: Option<UncheckedAccount<'info>>,
    /// CHECK: receives a claim board's held stake: its worker or its owner, as settle_claims decides
    #[account(mut)]
    pub stake_to: Option<UncheckedAccount<'info>>,
    /// CHECK: the config's fee recipient, paid instead of a recorded payer that cannot hold lamports
    #[account(mut)]
    pub fee_to: Option<UncheckedAccount<'info>>,
}

fn live_token_account(vault: &AccountInfo) -> bool {
    let token_owned =
        *vault.owner == anchor_spl::token::ID || *vault.owner == anchor_spl::token_2022::ID;
    token_owned && !vault.data_is_empty()
}

fn escrow_open(escrow: &AccountInfo, now: i64) -> Result<bool> {
    let frozen = {
        let data = escrow.try_borrow_data()?;
        *escrow.owner == crate::ID && is_intent(&data) && !readable(&data)
    };
    Ok(!frozen && escrow_deadline(escrow, now)?.is_some())
}

fn fee_recipient(config: Option<&AccountLoader<Config>>) -> Result<Pubkey> {
    let config = config.ok_or(EngineError::LegacyPayeeMismatch)?;
    Ok(config.load()?.fee_recipient)
}

pub fn handle_close_legacy(ctx: Context<CloseLegacy>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let account = ctx.accounts.account.to_account_info();
    let (recorded, intent, board, line) = {
        let data = account.try_borrow_data()?;
        require!(!is_current(&data), EngineError::NotLegacy);
        require!(!migrates_in_place(&data), EngineError::LegacyMigrates);
        (
            recorded_payer(&data),
            is_intent(&data),
            board_terms(&data),
            line_intent(&data),
        )
    };
    if let Some(recorded_intent) = line {
        let escrow = ctx
            .accounts
            .intent
            .as_ref()
            .ok_or(EngineError::ClaimsMissing)?;
        require_keys_eq!(escrow.key(), recorded_intent, EngineError::ClaimsMissing);
        require!(
            !escrow_open(&escrow.to_account_info(), now)?,
            EngineError::LegacyLineOpen
        );
    }
    if intent {
        let vault = ctx
            .accounts
            .vault
            .as_ref()
            .ok_or(EngineError::LegacyVaultOpen)?;
        let derived =
            Pubkey::find_program_address(&[VAULT_SEED, account.key.as_ref()], &crate::ID).0;
        require_keys_eq!(vault.key(), derived, EngineError::LegacyVaultOpen);
        require!(!live_token_account(vault), EngineError::LegacyVaultOpen);
    }
    let payee = match recorded {
        Some(wallet) => wallet,
        None => fee_recipient(ctx.accounts.config.as_ref())?,
    };
    require_keys_eq!(
        ctx.accounts.payee.key(),
        payee,
        EngineError::LegacyPayeeMismatch
    );
    require_keys_neq!(account.key(), payee, EngineError::LegacyPayeeMismatch);
    let rent_to = if ctx.accounts.payee.executable {
        let fees = fee_recipient(ctx.accounts.config.as_ref())?;
        let to = ctx
            .accounts
            .fee_to
            .as_ref()
            .ok_or(EngineError::LegacyPayeeMismatch)?;
        require_keys_eq!(to.key(), fees, EngineError::LegacyPayeeMismatch);
        to.to_account_info()
    } else {
        ctx.accounts.payee.to_account_info()
    };
    let mut staked = 0;
    if let Some(terms) = board.filter(|t| t.held > 0) {
        let slot = Slot::at(terms.worker.to_bytes(), terms.until, now);
        let receiver = match stake_on_settle(slot, false).map_err(core_err)? {
            Some(StakeTo::Worker) => Some(terms.worker),
            Some(StakeTo::Owner) => Some(terms.owner),
            None => None,
        };
        if let Some(receiver) = receiver.filter(|r| *r != rent_to.key()) {
            let to = ctx
                .accounts
                .stake_to
                .as_ref()
                .ok_or(EngineError::StakeAccountMismatch)?;
            require_keys_eq!(to.key(), receiver, EngineError::StakeAccountMismatch);
            staked = terms.held.min(account.lamports());
            move_lamports(&account, &to.to_account_info(), staked)?;
        }
    }
    let lamports = close_entry(&account, &rent_to)?;
    emit_cpi!(LegacyClosed {
        account: account.key(),
        payee: rent_to.key(),
        lamports,
        stake: staked,
    });
    Ok(())
}
