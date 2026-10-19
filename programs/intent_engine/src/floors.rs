use anchor_lang::prelude::*;

use crate::errors::EngineError;
use crate::state::{Committee, Config, COMMITTEE_VERSION, FLOOR_THRESHOLD};

fn slot_of(config: &Config, mint: &Pubkey) -> Option<usize> {
    config
        .floor_mints
        .iter()
        .zip(config.floor_amounts.iter())
        .position(|(held, amount)| held == mint && *amount > 0)
}

pub fn committee_floor(config: &Config, mint: &Pubkey) -> u64 {
    slot_of(config, mint)
        .and_then(|i| config.floor_amounts.get(i).copied())
        .unwrap_or(0)
}

pub fn place_floor(config: &mut Config, mint: &Pubkey, floor: u64) -> Result<()> {
    let slot = match slot_of(config, mint) {
        Some(i) => i,
        None if floor == 0 => return Ok(()),
        None => config
            .floor_amounts
            .iter()
            .position(|amount| *amount == 0)
            .ok_or(EngineError::CommitteeFloorsFull)?,
    };
    let held = config
        .floor_mints
        .get_mut(slot)
        .ok_or(EngineError::CommitteeFloorsFull)?;
    *held = if floor == 0 { Pubkey::default() } else { *mint };
    let amount = config
        .floor_amounts
        .get_mut(slot)
        .ok_or(EngineError::CommitteeFloorsFull)?;
    *amount = floor;
    Ok(())
}

pub fn check_committee_floor(
    floor: u64,
    escrow: u64,
    attestor: &Pubkey,
    committee: Option<&AccountLoader<Committee>>,
) -> Result<()> {
    if floor == 0 || escrow < floor {
        return Ok(());
    }
    let committee = committee.ok_or(EngineError::CommitteeRequired)?;
    require_keys_eq!(committee.key(), *attestor, EngineError::CommitteeRequired);
    let stored = committee.load()?;
    require!(
        stored.version == COMMITTEE_VERSION,
        EngineError::AccountOutdated
    );
    require!(
        stored.threshold >= FLOOR_THRESHOLD,
        EngineError::CommitteeRequired
    );
    Ok(())
}
