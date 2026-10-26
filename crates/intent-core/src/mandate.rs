use crate::clock::after;
use crate::kinds::{Intent, Kind};
use crate::Error;

pub const MANDATE_NONCE_BIT: u64 = 1 << 63;

pub const fn is_mandated_nonce(nonce: u64) -> bool {
    nonce & MANDATE_NONCE_BIT != 0
}

pub const LANE_SHIFT: u32 = 32;
pub const LANE_MASK: u64 = !0xffff_ffff;
pub const MAX_LANE_SERIAL: u64 = (1 << 31) - 1;

pub fn lane_of(serial: u64) -> Option<u64> {
    if serial == 0 || serial > MAX_LANE_SERIAL {
        return None;
    }
    serial
        .checked_shl(LANE_SHIFT)
        .map(|shifted| MANDATE_NONCE_BIT | shifted)
}

pub fn in_lane(nonce: u64, serial: u64) -> bool {
    lane_of(serial).is_some_and(|lane| nonce & LANE_MASK == lane)
}

pub const MANDATE_KINDS: u64 =
    Kind::SwapExactIn.bit() | Kind::LimitOrder.bit() | Kind::DutchAuction.bit();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub kinds: u8,
    pub per_intent: u64,
    pub total: u64,
    pub max_intents: u32,
    pub max_ttl: i64,
    pub valid_until: i64,
    pub floor_out: u64,
    pub floor_in: u64,
    pub agent_fee: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Usage {
    pub spent: u64,
    pub intents: u32,
}

impl Limits {
    pub fn validate(self, now: i64) -> Result<Self, Error> {
        let sound = self.kinds != 0
            && u64::from(self.kinds) & !MANDATE_KINDS == 0
            && self.per_intent > self.agent_fee
            && self.total >= self.per_intent
            && self.max_intents != 0
            && self.max_ttl > 0
            && self.valid_until > now
            && self.floor_out != 0
            && self.floor_in != 0;
        if sound {
            Ok(self)
        } else {
            Err(Error::MandateInvalid)
        }
    }

    pub fn admit(
        &self,
        usage: Usage,
        intent: &Intent,
        expires_at: i64,
        now: i64,
    ) -> Result<Usage, Error> {
        if now >= self.valid_until {
            return Err(Error::MandateExpired);
        }
        let worst = worst_out(intent)
            .filter(|_| u64::from(self.kinds) & intent.kind().bit() != 0)
            .ok_or(Error::MandateKind)?;
        if i128::from(expires_at) > after(now, self.max_ttl) {
            return Err(Error::MandateTtl);
        }
        let cost = intent
            .escrow_amount()
            .checked_add(self.agent_fee)
            .filter(|c| *c <= self.per_intent)
            .ok_or(Error::MandateCap)?;
        let spent = usage
            .spent
            .checked_add(cost)
            .filter(|s| *s <= self.total)
            .ok_or(Error::MandateBudget)?;
        let intents = usage
            .intents
            .checked_add(1)
            .filter(|n| *n <= self.max_intents)
            .ok_or(Error::MandateCount)?;
        let offered = u128::from(worst).wrapping_mul(u128::from(self.floor_in));
        let floor = u128::from(cost).wrapping_mul(u128::from(self.floor_out));
        if offered < floor {
            return Err(Error::MandatePrice);
        }
        Ok(Usage { spent, intents })
    }
}

pub fn worst_out(intent: &Intent) -> Option<u64> {
    match intent {
        Intent::SwapExactIn(p) => Some(p.min_out),
        Intent::LimitOrder(p) => Some(p.take_amount),
        Intent::DutchAuction(p) => Some(p.end_out),
        Intent::AttestedResult(_) => None,
    }
}
