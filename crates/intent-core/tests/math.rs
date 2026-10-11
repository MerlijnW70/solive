use intent_core::math::{mul_div_ceil, mul_div_floor};
use intent_core::Error;
use proptest::prelude::*;

#[test]
fn floor_and_ceil_round_inexact_quotients_apart() {
    assert_eq!(mul_div_floor(7, 3, 2), Ok(10));
    assert_eq!(mul_div_ceil(7, 3, 2), Ok(11));
}

#[test]
fn floor_and_ceil_agree_on_exact_quotients() {
    assert_eq!(mul_div_floor(6, 4, 3), Ok(8));
    assert_eq!(mul_div_ceil(6, 4, 3), Ok(8));
    assert_eq!(mul_div_floor(3, 4, 1), Ok(12));
    assert_eq!(mul_div_ceil(3, 4, 1), Ok(12));
}

#[test]
fn zero_divisor_is_rejected() {
    assert_eq!(mul_div_floor(1, 1, 0), Err(Error::DivideByZero));
    assert_eq!(mul_div_ceil(1, 1, 0), Err(Error::DivideByZero));
}

#[test]
fn wide_intermediate_product_does_not_overflow() {
    assert_eq!(mul_div_floor(u64::MAX, u64::MAX, u64::MAX), Ok(u64::MAX));
    assert_eq!(mul_div_ceil(u64::MAX, u64::MAX, u64::MAX), Ok(u64::MAX));
}

#[test]
fn quotient_beyond_u64_is_overflow() {
    assert_eq!(mul_div_floor(u64::MAX, 2, 1), Err(Error::Overflow));
    assert_eq!(mul_div_ceil(u64::MAX, 2, 1), Err(Error::Overflow));
}

#[test]
fn ceil_rounding_up_past_u64_is_overflow() {
    assert_eq!(mul_div_floor(u64::MAX, 3, 3), Ok(u64::MAX));
    assert_eq!(mul_div_floor(u64::MAX, 4, 4), Ok(u64::MAX));
    assert_eq!(
        mul_div_floor(31, 1_190_112_520_884_487_201, 2),
        Ok(u64::MAX)
    );
    assert_eq!(
        mul_div_ceil(31, 1_190_112_520_884_487_201, 2),
        Err(Error::Overflow)
    );
    assert_eq!(
        mul_div_ceil(u64::MAX, u64::MAX, u64::MAX - 1),
        Err(Error::Overflow)
    );
    assert_eq!(
        mul_div_floor(u64::MAX, u64::MAX - 1, u64::MAX),
        Ok(u64::MAX - 1)
    );
}

proptest! {
    #[test]
    fn floor_and_ceil_bracket_the_exact_ratio(a: u64, b: u64, d in 1u64..) {
        let p = u128::from(a).wrapping_mul(u128::from(b));
        let dd = u128::from(d);
        match (mul_div_floor(a, b, d), mul_div_ceil(a, b, d)) {
            (Ok(f), Ok(c)) => {
                let f = u128::from(f);
                let c = u128::from(c);
                prop_assert!(f.wrapping_mul(dd) <= p);
                prop_assert!(f.wrapping_add(1).wrapping_mul(dd) > p);
                prop_assert!(c.wrapping_mul(dd) >= p);
                prop_assert!(c == f || c == f.wrapping_add(1));
                prop_assert_eq!(c == f, p.checked_rem(dd) == Some(0));
            }
            (Ok(f), Err(e)) => {
                prop_assert_eq!(f, u64::MAX);
                prop_assert_eq!(e, Error::Overflow);
            }
            (Err(e), Err(g)) => {
                prop_assert_eq!(e, Error::Overflow);
                prop_assert_eq!(g, Error::Overflow);
                prop_assert!(p.checked_div(dd) > Some(u128::from(u64::MAX)));
            }
            (Err(_), Ok(_)) => prop_assert!(false),
        }
    }
}
