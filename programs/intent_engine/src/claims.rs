use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use bytemuck::Zeroable;
use intent_core::claim::{serve_until, Claim, Cooldown, Line, Payout, Slot, StakeTo};
use intent_core::kinds::Intent as CoreIntent;
use intent_core::lifecycle::Status;
use intent_core::Error as CoreError;

use crate::errors::{core_err, EngineError};
use crate::events::{
    JobClaimed, LineLeft, ReviewLapsed, StakeMoved, STAKE_TO_OWNER, STAKE_TO_WORKER,
};
use crate::state::{
    intent_readable, ClaimBoard, Intent, Standby, CLAIMS_OPEN, CLAIMS_SEED, STANDBY_SEED,
    STANDBY_VERSION,
};
use crate::versions::{is_current, legacy_board, readable};

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

pub fn stored_bump(board: &AccountInfo) -> Result<u8> {
    require_keys_eq!(*board.owner, crate::ID, EngineError::ClaimsMissing);
    let data = board.try_borrow_data()?;
    require!(
        data.get(..ClaimBoard::DISCRIMINATOR.len()) == Some(ClaimBoard::DISCRIMINATOR),
        EngineError::ClaimsMissing
    );
    let at = ClaimBoard::DISCRIMINATOR
        .len()
        .checked_add(core::mem::offset_of!(ClaimBoard, bump))
        .ok_or(EngineError::Overflow)?;
    Ok(*data.get(at).ok_or(EngineError::ClaimsMissing)?)
}

pub fn stored_attestor(intent: &AccountInfo) -> Pubkey {
    if *intent.owner != crate::ID {
        return Pubkey::default();
    }
    let Ok(data) = intent.try_borrow_data() else {
        return Pubkey::default();
    };
    let disc = Intent::DISCRIMINATOR;
    if data.get(..disc.len()) != Some(disc) {
        return Pubkey::default();
    }
    let Some(held) = data
        .get(disc.len()..Intent::SPACE)
        .and_then(|body| bytemuck::try_from_bytes::<Intent>(body).ok())
    else {
        return Pubkey::default();
    };
    match CoreIntent::decode(held.kind, &held.params) {
        Ok(CoreIntent::AttestedResult(p)) => Pubkey::new_from_array(p.attestor),
        _ => Pubkey::default(),
    }
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

pub struct HandOver {
    pub claimed: Option<JobClaimed>,
    pub refunded: Vec<LineLeft>,
}

pub fn hand_over<'info>(
    loader: &AccountLoader<'info, ClaimBoard>,
    entries: &[AccountInfo<'info>],
    next_worker: Option<&AccountInfo<'info>>,
    dropper: Option<&AccountInfo<'info>>,
    now: i64,
    expires_at: i64,
) -> Result<HandOver> {
    let (intent, stake, mut line, slot, cooldown) = {
        let board = loader.load()?;
        (
            board.intent,
            board.stake,
            line_of(&board),
            slot_of(&board, now),
            cooldown_of(&board),
        )
    };
    let mut served = None;
    let mut refunded = Vec::new();
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
        match cooldown.check(slot, standby.worker.to_bytes(), now) {
            Ok(()) => {}
            Err(CoreError::ClaimCooldown) => {
                let to = dropper.ok_or(EngineError::StakeAccountMismatch)?;
                require_keys_eq!(*to.key, standby.worker, EngineError::StakeAccountMismatch);
                refunded.push(LineLeft {
                    intent,
                    worker: standby.worker,
                    seq,
                    refunded: close_entry(entry, to)?,
                });
                continue;
            }
            Err(e) => return Err(core_err(e).into()),
        }
        let to = next_worker.ok_or(EngineError::StakeAccountMismatch)?;
        require_keys_eq!(*to.key, standby.worker, EngineError::StakeAccountMismatch);
        move_lamports(entry, &loader.to_account_info(), stake)?;
        close_entry(entry, to)?;
        let until = serve_until(now, standby.secs, expires_at);
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
    Ok(HandOver {
        claimed: served,
        refunded,
    })
}

pub fn claim_of(board: &ClaimBoard) -> Claim {
    Claim {
        worker: board.worker.to_bytes(),
        until: board.until,
        held: board.held,
        review_until: board.review_until,
        kill_fee: board.kill_fee,
    }
}

pub fn slot_of(board: &ClaimBoard, now: i64) -> Slot {
    claim_of(board).slot(now)
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
    board.review_ann = Pubkey::default();
    board.review_until = 0;
}

pub fn settle_lapse(board: &mut ClaimBoard) {
    clear(board);
    board.kill_fee = 0;
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

pub fn with_board<R>(data: &mut [u8], read: impl FnOnce(&mut ClaimBoard) -> R) -> Result<R> {
    require!(
        data.get(..ClaimBoard::DISCRIMINATOR.len()) == Some(ClaimBoard::DISCRIMINATOR),
        EngineError::ClaimsMissing
    );
    let head = ClaimBoard::DISCRIMINATOR.len();
    let space = data.len();
    if space < ClaimBoard::SPACE {
        require!(legacy_board(data), EngineError::AccountOutdated);
        let mut copy = ClaimBoard::zeroed();
        let prefix = space.checked_sub(head).ok_or(EngineError::Overflow)?;
        let stored = data
            .get_mut(head..space)
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

pub fn board_accepted(data: &[u8], older: bool) -> bool {
    if older {
        readable(data) || legacy_board(data)
    } else {
        is_current(data)
    }
}

pub fn read_board(account: &AccountInfo, older: bool) -> Result<ClaimBoard> {
    require_keys_eq!(*account.owner, crate::ID, EngineError::ClaimsMissing);
    let mut data = account.try_borrow_mut_data()?;
    require!(board_accepted(&data, older), EngineError::AccountOutdated);
    with_board(&mut data, |board| *board)
}

pub fn write_board(account: &AccountInfo, write: impl FnOnce(&mut ClaimBoard)) -> Result<()> {
    with_board(&mut account.try_borrow_mut_data()?, write)
}

pub fn pay_to(
    board: &AccountInfo,
    stored: &ClaimBoard,
    target: Option<&AccountInfo>,
    payout: Payout,
) -> Result<(Pubkey, u8)> {
    let (to, role) = stake_receiver(stored, payout.to);
    let target = target.ok_or(EngineError::StakeAccountMismatch)?;
    require_keys_eq!(*target.key, to, EngineError::StakeAccountMismatch);
    move_lamports(board, target, payout.amount)?;
    Ok((to, role))
}

pub struct Honored {
    pub moved: Option<StakeMoved>,
    pub lapsed: Option<ReviewLapsed>,
}

fn honor(
    account: &AccountInfo,
    stored: &ClaimBoard,
    stake_to: Option<&AccountInfo>,
    payout: Option<Payout>,
) -> Result<Honored> {
    let Some(payout) = payout else {
        return Ok(Honored {
            moved: None,
            lapsed: None,
        });
    };
    let (to, role) = pay_to(account, stored, stake_to, payout)?;
    let lapsed = claim_of(stored).armed();
    if lapsed {
        write_board(account, settle_lapse)?;
    } else {
        write_board(account, clear)?;
    }
    Ok(Honored {
        moved: Some(StakeMoved {
            intent: stored.intent,
            worker: stored.worker,
            to,
            amount: payout.amount,
            role,
        }),
        lapsed: lapsed.then_some(ReviewLapsed {
            intent: stored.intent,
            announcement: stored.review_ann,
            worker: stored.worker,
            attestor: Pubkey::default(),
            kill_fee: payout.kill_fee,
            stake: stored.held,
        }),
    })
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
    let stored = read_board(&account, false)?;
    let wallets: Vec<[u8; 32]> = payees.iter().map(Pubkey::to_bytes).collect();
    let payout = claim_of(&stored)
        .on_release(&wallets, now)
        .map_err(core_err)?;
    let Some(payout) = payout else {
        return Ok(None);
    };
    let (to, role) = pay_to(&account, &stored, stake_to, payout)?;
    write_board(&account, clear)?;
    Ok(Some(StakeMoved {
        intent: stored.intent,
        worker: stored.worker,
        to,
        amount: payout.amount,
        role,
    }))
}

pub fn cancel_board(claims: u8, board: Option<&AccountInfo>) -> Result<Option<ClaimBoard>> {
    if claims != CLAIMS_OPEN {
        return Ok(None);
    }
    let account = board.ok_or(EngineError::ClaimsMissing)?;
    if *account.owner != crate::ID {
        return Ok(None);
    }
    Ok(Some(read_board(account, true)?))
}

pub fn check_cancel_review(stored: Option<&ClaimBoard>, now: i64) -> Result<()> {
    if let Some(stored) = stored {
        let claim = claim_of(stored);
        if claim.armed() && now < claim.review_until {
            return err!(EngineError::ReviewPending);
        }
    }
    Ok(())
}

pub fn honor_on_cancel(
    stored: Option<&ClaimBoard>,
    board: Option<&AccountInfo>,
    stake_to: Option<&AccountInfo>,
    now: i64,
) -> Result<Honored> {
    let (Some(stored), Some(account)) = (stored, board) else {
        return Ok(Honored {
            moved: None,
            lapsed: None,
        });
    };
    let payout = claim_of(stored).on_cancel(now).map_err(core_err)?;
    honor(account, stored, stake_to, payout)
}

pub fn honor_on_settle<'info>(
    account: &AccountInfo<'info>,
    stored: &ClaimBoard,
    owner: &AccountInfo<'info>,
    worker: Option<&AccountInfo<'info>>,
    now: i64,
    open: bool,
) -> Result<Honored> {
    let payout = claim_of(stored).on_settle(now, open).map_err(core_err)?;
    let target = match payout.map(|p| p.to) {
        Some(StakeTo::Owner) => Some(owner),
        _ => worker,
    };
    honor(account, stored, target, payout)
}
