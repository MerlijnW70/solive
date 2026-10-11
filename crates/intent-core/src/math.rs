use crate::Error;

pub fn mul_div_floor(a: u64, b: u64, d: u64) -> Result<u64, Error> {
    let p = u128::from(a).wrapping_mul(u128::from(b));
    let q = p.checked_div(u128::from(d)).ok_or(Error::DivideByZero)?;
    u64::try_from(q).map_err(|_| Error::Overflow)
}

pub fn mul_div_ceil(a: u64, b: u64, d: u64) -> Result<u64, Error> {
    let p = u128::from(a).wrapping_mul(u128::from(b));
    let dd = u128::from(d);
    let q = p.checked_div(dd).ok_or(Error::DivideByZero)?;
    let up = if q.wrapping_mul(dd) == p {
        q
    } else {
        q.wrapping_add(1)
    };
    u64::try_from(up).map_err(|_| Error::Overflow)
}
