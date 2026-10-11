use crate::codec::{Reader, Writer};
use crate::math::mul_div_ceil;
use crate::{Error, PARAMS_LEN};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Params {
    pub make_amount: u64,
    pub take_amount: u64,
}

impl Params {
    pub fn decode(bytes: &[u8; PARAMS_LEN]) -> Result<Self, Error> {
        let mut r = Reader::new(bytes);
        let p = Self {
            make_amount: r.u64()?,
            take_amount: r.u64()?,
        };
        r.finish()?;
        p.validate()
    }

    pub fn encode(&self) -> Result<[u8; PARAMS_LEN], Error> {
        let mut out = [0u8; PARAMS_LEN];
        Writer::new(&mut out)
            .u64(self.make_amount)?
            .u64(self.take_amount)?;
        Ok(out)
    }

    pub fn validate(self) -> Result<Self, Error> {
        if self.make_amount == 0 || self.take_amount == 0 {
            Err(Error::InvalidParams)
        } else {
            Ok(self)
        }
    }

    pub fn required_out(&self, amount_in: u64) -> Result<u64, Error> {
        if amount_in == 0 || amount_in > self.make_amount {
            return Err(Error::AmountMismatch);
        }
        mul_div_ceil(self.take_amount, amount_in, self.make_amount)
    }
}
