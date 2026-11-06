use crate::clock::after;
use crate::delivery::{MAX_REVIEW_SECS, MIN_REVIEW_SECS};
use crate::Error;

pub const MAX_CLAIM_SECS: u32 = 7 * 24 * 60 * 60;
pub const MAX_CLAIM_STAKE: u64 = 100_000_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Terms {
    max_secs: u32,
    stake: u64,
}

impl Terms {
    pub fn new(max_secs: u32, stake: u64) -> Result<Self, Error> {
        if max_secs == 0 || max_secs > MAX_CLAIM_SECS || stake > MAX_CLAIM_STAKE {
            return Err(Error::ClaimTerms);
        }
        Ok(Self { max_secs, stake })
    }

    pub fn max_secs(&self) -> u32 {
        self.max_secs
    }

    pub fn stake(&self) -> u64 {
        self.stake
    }

    pub fn until(&self, now: i64, secs: u32, expires_at: i64) -> Result<i64, Error> {
        if secs == 0 || secs > self.max_secs {
            return Err(Error::ClaimTerms);
        }
        if after(now, i64::from(secs)) > i128::from(expires_at) {
            return Err(Error::ClaimTerms);
        }
        Ok(now.saturating_add(i64::from(secs)))
    }
}

pub fn serve_until(now: i64, secs: u32, expires_at: i64) -> i64 {
    now.saturating_add(i64::from(secs)).min(expires_at)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Slot {
    Free,
    Held { worker: [u8; 32], until: i64 },
    Lapsed { worker: [u8; 32] },
}

impl Slot {
    pub fn at(worker: [u8; 32], until: i64, now: i64) -> Self {
        if worker == [0; 32] {
            Self::Free
        } else if now < until {
            Self::Held { worker, until }
        } else {
            Self::Lapsed { worker }
        }
    }

    pub fn at_review(worker: [u8; 32], until: i64, review_until: i64, now: i64) -> Self {
        if review_until != 0 && worker != [0; 32] {
            Self::Held {
                worker,
                until: i64::MAX,
            }
        } else {
            Self::at(worker, until, now)
        }
    }

    pub fn claimable(&self) -> Result<(), Error> {
        match self {
            Self::Held { .. } => Err(Error::ClaimHeld),
            Self::Free | Self::Lapsed { .. } => Ok(()),
        }
    }

    pub fn may_pay(&self, payees: &[[u8; 32]]) -> Result<(), Error> {
        match self {
            Self::Held { worker, .. } if !payees.contains(worker) => Err(Error::ClaimHeld),
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cooldown {
    pub worker: [u8; 32],
    pub until: i64,
}

impl Cooldown {
    pub fn check(&self, slot: Slot, claimant: [u8; 32], now: i64) -> Result<(), Error> {
        slot.claimable()?;
        let barred = slot == Slot::Free
            && self.worker != [0; 32]
            && self.worker == claimant
            && now < self.until;
        if barred {
            return Err(Error::ClaimCooldown);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StakeTo {
    Worker,
    Owner,
}

pub fn stake_on_release(slot: Slot, payees: &[[u8; 32]]) -> Option<StakeTo> {
    match slot {
        Slot::Free => None,
        Slot::Held { worker, .. } if payees.contains(&worker) => Some(StakeTo::Worker),
        Slot::Held { .. } => None,
        Slot::Lapsed { .. } => Some(StakeTo::Owner),
    }
}

pub fn stake_on_cancel(slot: Slot) -> Option<StakeTo> {
    match slot {
        Slot::Free => None,
        Slot::Held { .. } => Some(StakeTo::Worker),
        Slot::Lapsed { .. } => Some(StakeTo::Owner),
    }
}

pub fn stake_on_settle(slot: Slot, escrow_open: bool) -> Result<Option<StakeTo>, Error> {
    match slot {
        Slot::Free => Ok(None),
        Slot::Held { .. } if escrow_open => Err(Error::ClaimHeld),
        Slot::Held { .. } => Ok(Some(StakeTo::Worker)),
        Slot::Lapsed { .. } => Ok(Some(StakeTo::Owner)),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Line {
    pub head: u32,
    pub tail: u32,
}

impl Line {
    pub fn waiting(&self) -> u32 {
        self.tail.saturating_sub(self.head)
    }

    pub fn is_empty(&self) -> bool {
        self.waiting() == 0
    }

    pub fn check_claim(&self) -> Result<(), Error> {
        if self.is_empty() {
            Ok(())
        } else {
            Err(Error::LineWaiting)
        }
    }

    pub fn check_join(&self, slot: Slot) -> Result<(), Error> {
        match slot {
            Slot::Held { .. } => Ok(()),
            Slot::Free | Slot::Lapsed { .. } if self.is_empty() => Err(Error::JobNotHeld),
            Slot::Free | Slot::Lapsed { .. } => Ok(()),
        }
    }

    pub fn check_advance(&self, slot: Slot) -> Result<(), Error> {
        slot.claimable()?;
        if self.is_empty() {
            return Err(Error::LineEmpty);
        }
        Ok(())
    }

    pub fn join(&mut self) -> Result<u32, Error> {
        let seq = self.tail;
        self.tail = self.tail.checked_add(1).ok_or(Error::Overflow)?;
        Ok(seq)
    }

    pub fn front(&self) -> Option<u32> {
        (self.head < self.tail).then_some(self.head)
    }

    pub fn pass(&mut self) -> Option<u32> {
        let seq = self.front()?;
        self.head = self.head.saturating_add(1);
        Some(seq)
    }

    pub fn serve(&mut self, mut present: impl FnMut(u32) -> bool) -> Option<u32> {
        while let Some(seq) = self.pass() {
            if present(seq) {
                return Some(seq);
            }
        }
        None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReviewTerms {
    review_secs: u32,
    kill_fee: u64,
}

impl ReviewTerms {
    pub fn new(review_secs: u32, kill_fee: u64, stake: u64, rent_min: u64) -> Result<Self, Error> {
        if review_secs != 0 && !(MIN_REVIEW_SECS..=MAX_REVIEW_SECS).contains(&review_secs) {
            return Err(Error::ReviewTerms);
        }
        if kill_fee != 0 && (review_secs == 0 || stake == 0) {
            return Err(Error::ReviewTerms);
        }
        if kill_fee != 0 && kill_fee < rent_min {
            return Err(Error::StakeBelowRent);
        }
        if kill_fee > MAX_CLAIM_STAKE {
            return Err(Error::ReviewTerms);
        }
        Ok(Self {
            review_secs,
            kill_fee,
        })
    }

    pub fn review_secs(&self) -> u32 {
        self.review_secs
    }

    pub fn kill_fee(&self) -> u64 {
        self.kill_fee
    }
}

pub fn review_fits(now: i64, secs: u32, review_secs: u32, expires_at: i64) -> Result<(), Error> {
    if review_secs == 0 {
        return Ok(());
    }
    let end = after(now, i64::from(secs)).saturating_add(i128::from(review_secs));
    if end > i128::from(expires_at) {
        return Err(Error::ReviewPastExpiry);
    }
    Ok(())
}

pub fn arm_review(
    review_secs: u32,
    review_until: i64,
    raw: Slot,
    announcer: [u8; 32],
    now: i64,
    expires_at: i64,
) -> Option<i64> {
    if review_secs == 0 || review_until != 0 {
        return None;
    }
    match raw {
        Slot::Held { worker, .. } if worker == announcer && worker != [0; 32] => {}
        _ => return None,
    }
    if after(now, i64::from(review_secs)) > i128::from(expires_at) {
        return None;
    }
    let until = now.checked_add(i64::from(review_secs))?;
    (until != 0).then_some(until)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Payout {
    pub to: StakeTo,
    pub amount: u64,
    pub kill_fee: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Claim {
    pub worker: [u8; 32],
    pub until: i64,
    pub held: u64,
    pub review_until: i64,
    pub kill_fee: u64,
}

impl Claim {
    pub fn armed(&self) -> bool {
        self.review_until != 0 && self.worker != [0; 32]
    }

    pub fn slot(&self, now: i64) -> Slot {
        Slot::at_review(self.worker, self.until, self.review_until, now)
    }

    fn stake(&self, to: Option<StakeTo>) -> Option<Payout> {
        to.map(|to| Payout {
            to,
            amount: self.held,
            kill_fee: 0,
        })
    }

    fn lapse(&self) -> Result<Option<Payout>, Error> {
        Ok(Some(Payout {
            to: StakeTo::Worker,
            amount: self
                .held
                .checked_add(self.kill_fee)
                .ok_or(Error::Overflow)?,
            kill_fee: self.kill_fee,
        }))
    }

    pub fn lapsed(&self, now: i64) -> bool {
        self.armed() && now >= self.review_until
    }

    pub fn on_release(&self, payees: &[[u8; 32]], now: i64) -> Result<Option<Payout>, Error> {
        let slot = self.slot(now);
        slot.may_pay(payees)?;
        Ok(self.stake(stake_on_release(slot, payees)))
    }

    pub fn on_cancel(&self, now: i64) -> Result<Option<Payout>, Error> {
        if self.armed() {
            if now < self.review_until {
                return Err(Error::ReviewPending);
            }
            return self.lapse();
        }
        Ok(self.stake(stake_on_cancel(self.slot(now))))
    }

    pub fn on_settle(&self, now: i64, escrow_open: bool) -> Result<Option<Payout>, Error> {
        if self.armed() {
            if escrow_open && now < self.review_until {
                return Err(Error::ClaimHeld);
            }
            return self.lapse();
        }
        Ok(self.stake(stake_on_settle(self.slot(now), escrow_open)?))
    }

    pub fn on_reject(&self, now: i64) -> Result<Payout, Error> {
        if !self.armed() || now >= self.review_until {
            return Err(Error::ReviewLapsed);
        }
        Ok(Payout {
            to: StakeTo::Worker,
            amount: self.held,
            kill_fee: 0,
        })
    }
}
