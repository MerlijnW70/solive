use anchor_lang::prelude::*;
use intent_core::claim::{stake_on_release, Slot, StakeTo};

use crate::errors::{core_err, EngineError};
use crate::events::{StakeMoved, STAKE_TO_OWNER, STAKE_TO_WORKER};
use crate::state::{ClaimBoard, CLAIMS_OPEN, CLAIMS_SEED, CLAIMS_VERSION};

pub fn board_address(intent: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[CLAIMS_SEED, intent.as_ref()], &crate::ID)
}

pub fn slot_of(board: &ClaimBoard, now: i64) -> Slot {
    Slot::at(board.worker.to_bytes(), board.until, now)
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
    let (intent, slot, held, receiver) = {
        let board = loader.load()?;
        require!(
            board.version == CLAIMS_VERSION,
            EngineError::UnsupportedVersion
        );
        let slot = slot_of(&board, now);
        let wallets: Vec<[u8; 32]> = payees.iter().map(Pubkey::to_bytes).collect();
        slot.may_pay(&wallets).map_err(core_err)?;
        let receiver = stake_on_release(slot, &wallets).map(|to| stake_receiver(&board, to));
        (board.intent, slot, board.held, receiver)
    };
    let Some((to, role)) = receiver else {
        return Ok(None);
    };
    let target = stake_to.ok_or(EngineError::StakeAccountMismatch)?;
    require_keys_eq!(*target.key, to, EngineError::StakeAccountMismatch);
    move_lamports(&loader.to_account_info(), target, held)?;
    let worker = match slot {
        Slot::Held { worker, .. } | Slot::Lapsed { worker } => Pubkey::new_from_array(worker),
        Slot::Free => Pubkey::default(),
    };
    let mut board = loader.load_mut()?;
    board.worker = Pubkey::default();
    board.until = 0;
    board.held = 0;
    Ok(Some(StakeMoved {
        intent,
        worker,
        to,
        amount: held,
        role,
    }))
}
