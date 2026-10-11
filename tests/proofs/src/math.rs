use intent_core::math::{mul_div_ceil, mul_div_floor};

#[kani::proof]
fn a_zero_divisor_is_refused_and_never_panics() {
    let a: u64 = kani::any();
    let b: u64 = kani::any();
    assert!(mul_div_floor(a, b, 0).is_err());
    assert!(mul_div_ceil(a, b, 0).is_err());
}
