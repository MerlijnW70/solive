use crate::codec::{Reader, Writer};
use crate::{Error, PARAMS_LEN};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Params {
    pub amount_in: u64,
    pub min_result: u64,
    pub max_result: u64,
    pub attestor: [u8; 32],
}

impl Params {
    pub fn decode(bytes: &[u8; PARAMS_LEN]) -> Result<Self, Error> {
        let mut r = Reader::new(bytes);
        let p = Self {
            amount_in: r.u64()?,
            min_result: r.u64()?,
            max_result: r.u64()?,
            attestor: r.key()?,
        };
        r.finish()?;
        p.validate()
    }

    pub fn encode(&self) -> Result<[u8; PARAMS_LEN], Error> {
        let mut out = [0u8; PARAMS_LEN];
        Writer::new(&mut out)
            .u64(self.amount_in)?
            .u64(self.min_result)?
            .u64(self.max_result)?
            .key(&self.attestor)?;
        Ok(out)
    }

    pub fn validate(self) -> Result<Self, Error> {
        if self.amount_in == 0 || self.min_result > self.max_result || self.attestor == [0; 32] {
            Err(Error::InvalidParams)
        } else {
            Ok(self)
        }
    }

    pub fn check_result(&self, amount_in: u64, result: u64) -> Result<(), Error> {
        if amount_in != self.amount_in {
            return Err(Error::AmountMismatch);
        }
        if result < self.min_result || result > self.max_result {
            return Err(Error::ResultOutOfBounds);
        }
        Ok(())
    }
}
