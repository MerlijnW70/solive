use anchor_lang::prelude::*;
use intent_core::roster::{admits, check_size, extend, Key, MAX_CLAIMANTS};

use crate::claims::{line_of, slot_of};
use crate::errors::{core_err, EngineError};
use crate::events::ClaimantsListed;
use crate::state::{ClaimBoard, ClaimList, CLAIM_LIST_VERSION, LISTED};

pub fn is_listed(board: &ClaimBoard) -> bool {
    board.listed != 0
}

pub fn check_unclaimed(board: &ClaimBoard, now: i64) -> Result<()> {
    slot_of(board, now).claimable().map_err(core_err)?;
    line_of(board).check_claim().map_err(core_err)?;
    Ok(())
}

pub fn add(list: &mut ClaimList, workers: &[Pubkey]) -> Result<ClaimantsListed> {
    require!(
        workers.len() <= MAX_CLAIMANTS,
        EngineError::ClaimListInvalid
    );
    let slots: &mut [Key; MAX_CLAIMANTS] = bytemuck::cast_mut(&mut list.workers);
    list.count =
        extend(slots, list.count, list.size, bytemuck::cast_slice(workers)).map_err(core_err)?;
    Ok(ClaimantsListed {
        intent: list.intent,
        owner: list.owner,
        size: list.size,
        count: list.count,
        workers: workers.to_vec(),
    })
}

pub fn start(
    list: &mut ClaimList,
    board: &mut ClaimBoard,
    bump: u8,
    size: u8,
    workers: &[Pubkey],
) -> Result<ClaimantsListed> {
    require!(!is_listed(board), EngineError::ClaimListSet);
    check_size(size, MAX_CLAIMANTS).map_err(core_err)?;
    list.intent = board.intent;
    list.owner = board.owner;
    list.size = size;
    list.count = 0;
    list.version = CLAIM_LIST_VERSION;
    list.bump = bump;
    board.listed = LISTED;
    add(list, workers)
}

pub fn check_listed(
    board: &ClaimBoard,
    list: Option<&AccountLoader<ClaimList>>,
    worker: &Pubkey,
) -> Result<()> {
    if !is_listed(board) {
        return Ok(());
    }
    let list = list.ok_or(EngineError::ClaimListMissing)?.load()?;
    require_keys_eq!(list.intent, board.intent, EngineError::ClaimListMissing);
    let slots: &[Key; MAX_CLAIMANTS] = bytemuck::cast_ref(&list.workers);
    admits(slots, list.count, list.size, &worker.to_bytes()).map_err(core_err)?;
    Ok(())
}
