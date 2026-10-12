use crate::fee::BPS_DENOMINATOR;
use crate::math::mul_div_floor;
use crate::Error;

pub const MAX_RECIPIENTS: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SplitPlan {
    amounts: [u64; MAX_RECIPIENTS],
    len: usize,
}

impl SplitPlan {
    pub fn as_slice(&self) -> &[u64] {
        self.amounts.get(..self.len).unwrap_or(&[])
    }

    pub fn total(&self) -> u64 {
        let mut t = 0u64;
        for &a in self.as_slice() {
            t = t.wrapping_add(a);
        }
        t
    }
}

pub fn split_n(amount: u64, weights_bps: &[u16]) -> Result<SplitPlan, Error> {
    let len = weights_bps.len();
    if len == 0 || len > MAX_RECIPIENTS {
        return Err(Error::InvalidParams);
    }
    let mut sum = 0u32;
    for &w in weights_bps {
        sum = sum.checked_add(u32::from(w)).ok_or(Error::Overflow)?;
    }
    if u64::from(sum) != BPS_DENOMINATOR {
        return Err(Error::InvalidParams);
    }
    let mut amounts = [0u64; MAX_RECIPIENTS];
    let mut distributed = 0u64;
    let mut heaviest = 0usize;
    let mut heaviest_w = 0u16;
    for ((i, &w), slot) in weights_bps.iter().enumerate().zip(amounts.iter_mut()) {
        let share = mul_div_floor(amount, u64::from(w), BPS_DENOMINATOR)?;
        *slot = share;
        distributed = distributed.checked_add(share).ok_or(Error::Overflow)?;
        if w > heaviest_w {
            heaviest_w = w;
            heaviest = i;
        }
    }
    let dust = amount.checked_sub(distributed).ok_or(Error::Overflow)?;
    let slot = amounts.get_mut(heaviest).ok_or(Error::InvalidParams)?;
    *slot = slot.checked_add(dust).ok_or(Error::Overflow)?;
    Ok(SplitPlan { amounts, len })
}
