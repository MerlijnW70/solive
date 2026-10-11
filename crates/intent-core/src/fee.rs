use crate::math::{mul_div_ceil, mul_div_floor};
use crate::Error;

pub const BPS_DENOMINATOR: u64 = 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Split {
    pub fee: u64,
    pub net: u64,
}

pub fn split_fee(amount: u64, fee_bps: u16) -> Result<Split, Error> {
    let fee = mul_div_ceil(amount, u64::from(fee_bps), BPS_DENOMINATOR)?;
    let net = amount.checked_sub(fee).ok_or(Error::InvalidParams)?;
    Ok(Split { fee, net })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fees {
    pub protocol: u64,
    pub partner: u64,
    pub net: u64,
}

pub fn split_fees(
    amount: u64,
    fee_bps: u16,
    partner_bps: u16,
    cut_bps: u16,
) -> Result<Fees, Error> {
    let fee = mul_div_ceil(amount, u64::from(fee_bps), BPS_DENOMINATOR)?;
    let gross = mul_div_ceil(amount, u64::from(partner_bps), BPS_DENOMINATOR)?;
    let cut = mul_div_floor(gross, u64::from(cut_bps), BPS_DENOMINATOR)?;
    let partner = gross.checked_sub(cut).ok_or(Error::InvalidParams)?;
    let protocol = fee.checked_add(cut).ok_or(Error::Overflow)?;
    let net = amount
        .checked_sub(fee)
        .and_then(|rest| rest.checked_sub(gross))
        .ok_or(Error::InvalidParams)?;
    Ok(Fees {
        protocol,
        partner,
        net,
    })
}
