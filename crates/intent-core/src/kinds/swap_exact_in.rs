use crate::codec::{Reader, Writer};
use crate::{Error, PARAMS_LEN};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Params {
    pub amount_in: u64,
    pub min_out: u64,
}

impl Params {
    pub fn decode(bytes: &[u8; PARAMS_LEN]) -> Result<Self, Error> {
        let mut r = Reader::new(bytes);
        let p = Self {
            amount_in: r.u64()?,
            min_out: r.u64()?,
        };
        r.finish()?;
        p.validate()
    }

    pub fn encode(&self) -> Result<[u8; PARAMS_LEN], Error> {
        let mut out = [0u8; PARAMS_LEN];
        Writer::new(&mut out)
            .u64(self.amount_in)?
            .u64(self.min_out)?;
        Ok(out)
    }

    pub fn validate(self) -> Result<Self, Error> {
        if self.amount_in == 0 || self.min_out == 0 {
            Err(Error::InvalidParams)
        } else {
            Ok(self)
        }
    }

    pub fn required_out(&self, amount_in: u64) -> Result<u64, Error> {
        if amount_in == self.amount_in {
            Ok(self.min_out)
        } else {
            Err(Error::AmountMismatch)
        }
    }
}
