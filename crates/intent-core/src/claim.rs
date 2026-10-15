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
        let until = now.checked_add(i64::from(secs)).ok_or(Error::Overflow)?;
        if until > expires_at {
            return Err(Error::ClaimTerms);
        }
        Ok(until)
    }
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
pub enum StakeTo {
    Worker,
    Owner,
}

pub fn stake_on_release(slot: Slot, payees: &[[u8; 32]]) -> Option<StakeTo> {
    match slot {
        Slot::Free => None,
        Slot::Held { worker, .. } if payees.contains(&worker) => Some(StakeTo::Worker),
        Slot::Held { .. } => None,
        Slot::Lapsed { worker } if payees.contains(&worker) => Some(StakeTo::Worker),
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
