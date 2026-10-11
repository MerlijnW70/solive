pub mod attested_result;
pub mod dutch_auction;
pub mod limit_order;
pub mod swap_exact_in;

use crate::{Error, PARAMS_LEN};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    SwapExactIn = 1,
    LimitOrder = 2,
    DutchAuction = 3,
    AttestedResult = 4,
}

impl Kind {
    pub const fn bit(self) -> u64 {
        match self {
            Self::SwapExactIn => 0b10,
            Self::LimitOrder => 0b100,
            Self::DutchAuction => 0b1000,
            Self::AttestedResult => 0b1_0000,
        }
    }

    pub const fn enabled_in(self, mask: u64) -> bool {
        mask & self.bit() != 0
    }
}

pub const ALL_KINDS_MASK: u64 = Kind::SwapExactIn.bit()
    | Kind::LimitOrder.bit()
    | Kind::DutchAuction.bit()
    | Kind::AttestedResult.bit();

impl TryFrom<u8> for Kind {
    type Error = Error;

    fn try_from(v: u8) -> Result<Self, Error> {
        match v {
            1 => Ok(Self::SwapExactIn),
            2 => Ok(Self::LimitOrder),
            3 => Ok(Self::DutchAuction),
            4 => Ok(Self::AttestedResult),
            _ => Err(Error::UnknownKind),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Intent {
    SwapExactIn(swap_exact_in::Params),
    LimitOrder(limit_order::Params),
    DutchAuction(dutch_auction::Params),
    AttestedResult(attested_result::Params),
}

impl Intent {
    pub fn decode(kind: u8, params: &[u8; PARAMS_LEN]) -> Result<Self, Error> {
        match Kind::try_from(kind)? {
            Kind::SwapExactIn => swap_exact_in::Params::decode(params).map(Self::SwapExactIn),
            Kind::LimitOrder => limit_order::Params::decode(params).map(Self::LimitOrder),
            Kind::DutchAuction => dutch_auction::Params::decode(params).map(Self::DutchAuction),
            Kind::AttestedResult => {
                attested_result::Params::decode(params).map(Self::AttestedResult)
            }
        }
    }

    pub fn kind(&self) -> Kind {
        match self {
            Self::SwapExactIn(_) => Kind::SwapExactIn,
            Self::LimitOrder(_) => Kind::LimitOrder,
            Self::DutchAuction(_) => Kind::DutchAuction,
            Self::AttestedResult(_) => Kind::AttestedResult,
        }
    }

    pub fn fits_expiry(&self, expires_at: i64) -> bool {
        match self {
            Self::DutchAuction(p) => p.end_ts <= expires_at,
            Self::SwapExactIn(_) | Self::LimitOrder(_) | Self::AttestedResult(_) => true,
        }
    }

    pub fn escrow_amount(&self) -> u64 {
        match self {
            Self::SwapExactIn(p) => p.amount_in,
            Self::LimitOrder(p) => p.make_amount,
            Self::DutchAuction(p) => p.amount_in,
            Self::AttestedResult(p) => p.amount_in,
        }
    }

    pub fn encode(&self) -> Result<[u8; PARAMS_LEN], Error> {
        match self {
            Self::SwapExactIn(p) => p.encode(),
            Self::LimitOrder(p) => p.encode(),
            Self::DutchAuction(p) => p.encode(),
            Self::AttestedResult(p) => p.encode(),
        }
    }

    pub fn required_out(&self, amount_in: u64, now: i64) -> Result<u64, Error> {
        match self {
            Self::SwapExactIn(p) => p.required_out(amount_in),
            Self::LimitOrder(p) => p.required_out(amount_in),
            Self::DutchAuction(p) => p.required_out(amount_in, now),
            Self::AttestedResult(_) => Err(Error::KindMismatch),
        }
    }

    pub fn check_attested(&self, amount_in: u64, result: u64) -> Result<[u8; 32], Error> {
        match self {
            Self::AttestedResult(p) => p.check_result(amount_in, result).map(|()| p.attestor),
            Self::SwapExactIn(_) | Self::LimitOrder(_) | Self::DutchAuction(_) => {
                Err(Error::KindMismatch)
            }
        }
    }

    pub fn settle_delta(
        &self,
        amount_in: u64,
        before: u64,
        after: u64,
        now: i64,
    ) -> Result<u64, Error> {
        let delivered = after.checked_sub(before).ok_or(Error::Overflow)?;
        self.settle(amount_in, delivered, now)?;
        Ok(delivered)
    }

    pub fn settle(&self, amount_in: u64, amount_out: u64, now: i64) -> Result<(), Error> {
        if amount_out >= self.required_out(amount_in, now)? {
            Ok(())
        } else {
            Err(Error::InsufficientOutput)
        }
    }
}
