use anchor_lang::prelude::*;
use intent_core::claim::{stake_on_cancel, stake_on_release, Cooldown, Slot, StakeTo};

use crate::errors::{core_err, EngineError};
use crate::events::{StakeMoved, STAKE_TO_OWNER, STAKE_TO_WORKER};
use crate::state::{ClaimBoard, CLAIMS_OPEN, CLAIMS_SEED, CLAIMS_VERSION};

pub fn board_address(intent: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[CLAIMS_SEED, intent.as_ref()], &crate::ID)
}

pub fn slot_of(board: &ClaimBoard, now: i64) -> Slot {
    Slot::at(board.worker.to_bytes(), board.until, now)
}

pub fn cooldown_of(board: &ClaimBoard) -> Cooldown {
    Cooldown {
        worker: board.dropped_by.to_bytes(),
        until: board.until,
    }
}

pub fn clear(board: &mut ClaimBoard) {
    board.worker = Pubkey::default();
    board.until = 0;
    board.held = 0;
    board.dropped_by = Pubkey::default();
}

pub fn move_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let left = from
        .lamports()
        .checked_sub(amount)
        .ok_or(EngineError::Overflow)?;
    let grown = to
        .lamports()
        .checked_add(amount)
        .ok_or(EngineError::Overflow)?;
    **from.try_borrow_mut_lamports()? = left;
    **to.try_borrow_mut_lamports()? = grown;
    Ok(())
}

pub fn stake_receiver(board: &ClaimBoard, to: StakeTo) -> (Pubkey, u8) {
    match to {
        StakeTo::Worker => (board.worker, STAKE_TO_WORKER),
        StakeTo::Owner => (board.owner, STAKE_TO_OWNER),
    }
}

struct Decided {
    intent: Pubkey,
    slot: Slot,
    held: u64,
    receiver: Option<(Pubkey, u8)>,
}

fn decide(
    loader: &AccountLoader<ClaimBoard>,
    now: i64,
    rule: impl FnOnce(Slot) -> Result<Option<StakeTo>>,
) -> Result<Decided> {
    let board = loader.load()?;
    require!(
        board.version == CLAIMS_VERSION,
        EngineError::UnsupportedVersion
    );
    let slot = slot_of(&board, now);
    let receiver = rule(slot)?.map(|to| stake_receiver(&board, to));
    Ok(Decided {
        intent: board.intent,
        slot,
        held: board.held,
        receiver,
    })
}

fn pay_stake(
    loader: &AccountLoader<ClaimBoard>,
    stake_to: Option<&AccountInfo>,
    decided: Decided,
) -> Result<Option<StakeMoved>> {
    let Some((to, role)) = decided.receiver else {
        return Ok(None);
    };
    let target = stake_to.ok_or(EngineError::StakeAccountMismatch)?;
    require_keys_eq!(*target.key, to, EngineError::StakeAccountMismatch);
    move_lamports(&loader.to_account_info(), target, decided.held)?;
    let worker = match decided.slot {
        Slot::Held { worker, .. } | Slot::Lapsed { worker } => Pubkey::new_from_array(worker),
        Slot::Free => Pubkey::default(),
    };
    clear(&mut *loader.load_mut()?);
    Ok(Some(StakeMoved {
        intent: decided.intent,
        worker,
        to,
        amount: decided.held,
        role,
    }))
}

pub fn honor_on_release(
    claims: u8,
    board: Option<&AccountLoader<ClaimBoard>>,
    stake_to: Option<&AccountInfo>,
    payees: &[Pubkey],
    now: i64,
) -> Result<Option<StakeMoved>> {
    if claims != CLAIMS_OPEN {
        return Ok(None);
    }
    let loader = board.ok_or(EngineError::ClaimsMissing)?;
    let wallets: Vec<[u8; 32]> = payees.iter().map(Pubkey::to_bytes).collect();
    let decided = decide(loader, now, |slot| {
        slot.may_pay(&wallets).map_err(core_err)?;
        Ok(stake_on_release(slot, &wallets))
    })?;
    pay_stake(loader, stake_to, decided)
}

pub fn honor_on_cancel(
    claims: u8,
    board: Option<&AccountLoader<ClaimBoard>>,
    stake_to: Option<&AccountInfo>,
    now: i64,
) -> Result<Option<StakeMoved>> {
    if claims != CLAIMS_OPEN {
        return Ok(None);
    }
    let loader = board.ok_or(EngineError::ClaimsMissing)?;
    let decided = decide(loader, now, |slot| Ok(stake_on_cancel(slot)))?;
    pay_stake(loader, stake_to, decided)
}
