use crate::codec::{Reader, Writer};
use crate::math::mul_div_floor;
use crate::{Error, PARAMS_LEN};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Params {
    pub amount_in: u64,
    pub start_out: u64,
    pub end_out: u64,
    pub start_ts: i64,
    pub end_ts: i64,
}

impl Params {
    pub fn decode(bytes: &[u8; PARAMS_LEN]) -> Result<Self, Error> {
        let mut r = Reader::new(bytes);
        let p = Self {
            amount_in: r.u64()?,
            start_out: r.u64()?,
            end_out: r.u64()?,
            start_ts: r.i64()?,
            end_ts: r.i64()?,
        };
        r.finish()?;
        p.validate()
    }

    pub fn encode(&self) -> Result<[u8; PARAMS_LEN], Error> {
        let mut out = [0u8; PARAMS_LEN];
        Writer::new(&mut out)
            .u64(self.amount_in)?
            .u64(self.start_out)?
            .u64(self.end_out)?
            .i64(self.start_ts)?
            .i64(self.end_ts)?;
        Ok(out)
    }

    pub fn validate(self) -> Result<Self, Error> {
        if self.amount_in == 0
            || self.end_out == 0
            || self.start_out < self.end_out
            || self.start_ts >= self.end_ts
        {
            Err(Error::InvalidParams)
        } else {
            Ok(self)
        }
    }

    pub fn required_out(&self, amount_in: u64, now: i64) -> Result<u64, Error> {
        if amount_in != self.amount_in {
            return Err(Error::AmountMismatch);
        }
        let t = now.max(self.start_ts).min(self.end_ts);
        let decay = mul_div_floor(
            self.start_out.abs_diff(self.end_out),
            t.abs_diff(self.start_ts),
            self.end_ts.abs_diff(self.start_ts),
        )?;
        Ok(self.start_out.saturating_sub(decay))
    }
}
