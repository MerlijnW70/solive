use intent_core::bounty::split_n;
use intent_core::fee::BPS_DENOMINATOR;
use intent_core::math::mul_div_ceil;
use intent_core::Error;

#[test]
fn a_permutation_and_ceiling_laws_conserve_every_lamport() -> Result<(), Error> {
    let conserving: [&[u16]; 6] = [
        &[10_000],
        &[2500, 2500, 2500, 2500],
        &[5000, 3000, 2000],
        &[3333, 3333, 3334],
        &[1, 9999],
        &[625; 16],
    ];
    for weights in conserving {
        for amount in [0u64, 1, 7, 100, 999, 1_000_000, u64::from(u32::MAX)] {
            let plan = split_n(amount, weights)?;
            assert_eq!(plan.total(), amount, "weights {weights:?} amount {amount}");
            assert_eq!(plan.as_slice().len(), weights.len());
        }
    }

    let ceiling_cases: [(u64, &[u16]); 4] = [
        (1_000_000, &[4000, 5000, 1000]),
        (100, &[3333, 3333, 3334]),
        (7, &[5000, 3000, 2000]),
        (10_000, &[1, 9999]),
    ];
    for (amount, weights) in ceiling_cases {
        let plan = split_n(amount, weights)?;
        assert_eq!(plan.total(), amount);
        for (&share, &w) in plan.as_slice().iter().zip(weights.iter()) {
            let ceiling = mul_div_ceil(amount, u64::from(w), BPS_DENOMINATOR)?;
            assert!(share <= ceiling, "share {share} ceiling {ceiling}");
        }
    }

    let descending = split_n(7, &[5000, 3000, 2000])?;
    let ascending = split_n(7, &[2000, 3000, 5000])?;
    assert_eq!(descending.as_slice(), &[4, 2, 1]);
    assert_eq!(ascending.as_slice(), &[1, 2, 4]);
    assert_eq!(descending.total(), 7);
    assert_eq!(ascending.total(), 7);
    assert!(descending
        .as_slice()
        .iter()
        .rev()
        .eq(ascending.as_slice().iter()));

    let descending_big = split_n(101, &[6000, 3000, 1000])?;
    let ascending_big = split_n(101, &[1000, 3000, 6000])?;
    assert_eq!(descending_big.as_slice(), &[61, 30, 10]);
    assert_eq!(ascending_big.as_slice(), &[10, 30, 61]);
    assert_eq!(descending_big.total(), 101);
    assert_eq!(ascending_big.total(), 101);
    assert!(descending_big
        .as_slice()
        .iter()
        .rev()
        .eq(ascending_big.as_slice().iter()));

    Ok(())
}
