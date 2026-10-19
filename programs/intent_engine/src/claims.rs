use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use bytemuck::Zeroable;
use intent_core::claim::{stake_on_cancel, stake_on_release, Cooldown, Line, Slot, StakeTo};
use intent_core::lifecycle::Status;

use crate::errors::{core_err, EngineError};
use crate::events::{JobClaimed, StakeMoved, STAKE_TO_OWNER, STAKE_TO_WORKER};
use crate::state::{
    intent_readable, ClaimBoard, Intent, Standby, CLAIMS_OPEN, CLAIMS_SEED, STANDBY_SEED,
    STANDBY_VERSION,
};
use crate::versions::{is_current, legacy_board, readable, LEGACY_BOARD_SPACE};

pub fn board_address(intent: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[CLAIMS_SEED, intent.as_ref()], &crate::ID)
}

pub fn standby_address(intent: &Pubkey, seq: u32) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[STANDBY_SEED, intent.as_ref(), &seq.to_le_bytes()],
        &crate::ID,
    )
}

pub fn line_of(board: &ClaimBoard) -> Line {
    Line {
        head: board.head,
        tail: board.tail,
    }
}

pub fn escrow_deadline(intent: &AccountInfo, now: i64) -> Result<Option<i64>> {
    if *intent.owner != crate::ID {
        return Ok(None);
    }
    let data = intent.try_borrow_data()?;
    let disc = Intent::DISCRIMINATOR;
    if data.get(..disc.len()) != Some(disc) {
        return Ok(None);
    }
    let body = data
        .get(disc.len()..Intent::SPACE)
        .ok_or(EngineError::ClaimsMissing)?;
    let held: &Intent = bytemuck::try_from_bytes(body).map_err(|_| EngineError::ClaimsMissing)?;
    require!(intent_readable(held.version), EngineError::AccountOutdated);
    let status = Status::try_from(held.status).map_err(core_err)?;
    Ok((status == Status::Open && now < held.expires_at).then_some(held.expires_at))
}

pub fn read_standby(entry: &AccountInfo) -> Result<Standby> {
    let data = entry.try_borrow_data()?;
    let disc = Standby::DISCRIMINATOR;
    require!(
        data.get(..disc.len()) == Some(disc),
        EngineError::LineEntryMismatch
    );
    let body = data
        .get(disc.len()..Standby::SPACE)
        .ok_or(EngineError::LineEntryMismatch)?;
    let standby = bytemuck::try_from_bytes::<Standby>(body)
        .copied()
        .map_err(|_| error!(EngineError::LineEntryMismatch))?;
    require!(
        standby.version == STANDBY_VERSION,
        EngineError::AccountOutdated
    );
    Ok(standby)
}

pub fn close_entry<'info>(entry: &AccountInfo<'info>, to: &AccountInfo<'info>) -> Result<u64> {
    let all = entry.lamports();
    move_lamports(entry, to, all)?;
    entry.assign(&anchor_lang::system_program::ID);
    entry.resize(0)?;
    Ok(all)
}

pub fn line_entries<'info>(
    slots: [&Option<UncheckedAccount<'info>>; 4],
) -> Vec<AccountInfo<'info>> {
    slots
        .into_iter()
        .map_while(|slot| slot.as_ref().map(|account| account.to_account_info()))
        .collect()
}

pub fn hand_over<'info>(
    loader: &AccountLoader<'info, ClaimBoard>,
    entries: &[AccountInfo<'info>],
    next_worker: Option<&AccountInfo<'info>>,
    now: i64,
    expires_at: i64,
) -> Result<Option<JobClaimed>> {
    let (intent, stake, mut line) = {
        let board = loader.load()?;
        (board.intent, board.stake, line_of(&board))
    };
    let mut served = None;
    for entry in entries {
        let Some(seq) = line.pass() else {
            break;
        };
        require_keys_eq!(
            *entry.key,
            standby_address(&intent, seq).0,
            EngineError::LineEntryMismatch
        );
        if *entry.owner != crate::ID {
            continue;
        }
        let standby = read_standby(entry)?;
        let to = next_worker.ok_or(EngineError::StakeAccountMismatch)?;
        require_keys_eq!(*to.key, standby.worker, EngineError::StakeAccountMismatch);
        move_lamports(entry, &loader.to_account_info(), stake)?;
        close_entry(entry, to)?;
        let until = now
            .checked_add(i64::from(standby.secs))
            .ok_or(EngineError::Overflow)?
            .min(expires_at);
        served = Some(JobClaimed {
            intent,
            worker: standby.worker,
            until,
            stake,
        });
        break;
    }
    let mut board = loader.load_mut()?;
    board.head = line.head;
    if let Some(claimed) = &served {
        board.worker = claimed.worker;
        board.until = claimed.until;
        board.held = claimed.stake;
        board.dropped_by = Pubkey::default();
    }
    Ok(served)
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

fn with_board<R>(data: &mut [u8], read: impl FnOnce(&mut ClaimBoard) -> R) -> Result<R> {
    require!(
        data.get(..ClaimBoard::DISCRIMINATOR.len()) == Some(ClaimBoard::DISCRIMINATOR),
        EngineError::ClaimsMissing
    );
    let head = ClaimBoard::DISCRIMINATOR.len();
    if data.len() == LEGACY_BOARD_SPACE {
        let mut copy = ClaimBoard::zeroed();
        let prefix = LEGACY_BOARD_SPACE
            .checked_sub(head)
            .ok_or(EngineError::Overflow)?;
        let stored = data
            .get_mut(head..LEGACY_BOARD_SPACE)
            .ok_or(EngineError::AccountOutdated)?;
        let view = bytemuck::bytes_of_mut(&mut copy)
            .get_mut(..prefix)
            .ok_or(EngineError::AccountOutdated)?;
        view.copy_from_slice(stored);
        let out = read(&mut copy);
        let view = bytemuck::bytes_of(&copy)
            .get(..prefix)
            .ok_or(EngineError::AccountOutdated)?;
        stored.copy_from_slice(view);
        return Ok(out);
    }
    let body = data
        .get_mut(head..ClaimBoard::SPACE)
        .ok_or(EngineError::AccountOutdated)?;
    let board: &mut ClaimBoard =
        bytemuck::try_from_bytes_mut(body).map_err(|_| error!(EngineError::ClaimsMissing))?;
    Ok(read(board))
}

fn decide(
    account: &AccountInfo,
    now: i64,
    older: bool,
    rule: impl FnOnce(Slot) -> Result<Option<StakeTo>>,
) -> Result<Decided> {
    require_keys_eq!(*account.owner, crate::ID, EngineError::ClaimsMissing);
    let mut data = account.try_borrow_mut_data()?;
    let accepted = if older {
        readable(&data) || legacy_board(&data)
    } else {
        is_current(&data)
    };
    require!(accepted, EngineError::AccountOutdated);
    let (intent, slot, held, owner, worker) = with_board(&mut data, |board| {
        (
            board.intent,
            slot_of(board, now),
            board.held,
            board.owner,
            board.worker,
        )
    })?;
    let receiver = rule(slot)?.map(|to| match to {
        StakeTo::Worker => (worker, STAKE_TO_WORKER),
        StakeTo::Owner => (owner, STAKE_TO_OWNER),
    });
    Ok(Decided {
        intent,
        slot,
        held,
        receiver,
    })
}

fn pay_stake(
    account: &AccountInfo,
    stake_to: Option<&AccountInfo>,
    decided: Decided,
) -> Result<Option<StakeMoved>> {
    let Some((to, role)) = decided.receiver else {
        return Ok(None);
    };
    let target = stake_to.ok_or(EngineError::StakeAccountMismatch)?;
    require_keys_eq!(*target.key, to, EngineError::StakeAccountMismatch);
    move_lamports(account, target, decided.held)?;
    let worker = match decided.slot {
        Slot::Held { worker, .. } | Slot::Lapsed { worker } => Pubkey::new_from_array(worker),
        Slot::Free => Pubkey::default(),
    };
    with_board(&mut account.try_borrow_mut_data()?, clear)?;
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
    let account = board.ok_or(EngineError::ClaimsMissing)?.to_account_info();
    let wallets: Vec<[u8; 32]> = payees.iter().map(Pubkey::to_bytes).collect();
    let decided = decide(&account, now, false, |slot| {
        slot.may_pay(&wallets).map_err(core_err)?;
        Ok(stake_on_release(slot, &wallets))
    })?;
    pay_stake(&account, stake_to, decided)
}

pub fn honor_on_cancel(
    claims: u8,
    board: Option<&AccountInfo>,
    stake_to: Option<&AccountInfo>,
    now: i64,
) -> Result<Option<StakeMoved>> {
    if claims != CLAIMS_OPEN {
        return Ok(None);
    }
    let account = board.ok_or(EngineError::ClaimsMissing)?;
    if *account.owner != crate::ID {
        return Ok(None);
    }
    let decided = decide(account, now, true, |slot| Ok(stake_on_cancel(slot)))?;
    pay_stake(account, stake_to, decided)
}
