#![no_main]

use intent_core::bounty::{split_n, MAX_RECIPIENTS};
use intent_core::fee::{split_fees, BPS_DENOMINATOR};
use libfuzzer_sys::fuzz_target;

const D: u128 = BPS_DENOMINATOR as u128;

fn ceil(a: u128, b: u128) -> u128 {
    (a * b).div_ceil(D)
}

fn check_split_n(amount: u64, weights: &[u16]) {
    let sum: u32 = weights.iter().map(|&w| u32::from(w)).sum();
    let valid = !weights.is_empty()
        && weights.len() <= MAX_RECIPIENTS
        && u64::from(sum) == BPS_DENOMINATOR;
    let Ok(plan) = split_n(amount, weights) else {
        assert!(!valid);
        return;
    };
    assert!(valid);
    let shares = plan.as_slice();
    assert_eq!(shares.len(), weights.len());
    let total: u128 = shares.iter().map(|&s| u128::from(s)).sum();
    assert_eq!(total, u128::from(amount));
    assert_eq!(plan.total(), amount);
    let heaviest = weights
        .iter()
        .enumerate()
        .fold(0usize, |best, (i, &w)| if w > weights[best] { i } else { best });
    let floors: Vec<u128> = weights
        .iter()
        .map(|&w| u128::from(amount) * u128::from(w) / D)
        .collect();
    let floored: u128 = floors.iter().sum();
    let dust = u128::from(amount) - floored;
    assert!(dust < weights.len() as u128);
    for (i, (&share, &floor)) in shares.iter().zip(floors.iter()).enumerate() {
        if i == heaviest {
            assert_eq!(u128::from(share), floor + dust);
        } else {
            assert_eq!(u128::from(share), floor);
        }
    }
}

fn check_split_fees(amount: u64, fee_bps: u16, partner_bps: u16, cut_bps: u16) {
    let a = u128::from(amount);
    let fee = ceil(a, u128::from(fee_bps));
    let gross = ceil(a, u128::from(partner_bps));
    let max = u128::from(u64::MAX);
    let cut = gross * u128::from(cut_bps) / D;
    let settles = fee <= max && gross <= max && cut <= gross && fee + gross <= a;
    match split_fees(amount, fee_bps, partner_bps, cut_bps) {
        Ok(fees) => {
            assert!(settles);
            assert_eq!(u128::from(fees.protocol), fee + cut);
            assert_eq!(u128::from(fees.partner), gross - cut);
            assert_eq!(u128::from(fees.net), a - fee - gross);
            assert_eq!(
                u128::from(fees.net) + u128::from(fees.protocol) + u128::from(fees.partner),
                a
            );
        }
        Err(_) => assert!(!settles),
    }
    let bps = u128::from(fee_bps) + u128::from(partner_bps);
    if bps <= D && u128::from(cut_bps) <= D && a * (D - bps) >= 2 * D {
        assert!(split_fees(amount, fee_bps, partner_bps, cut_bps).is_ok());
    }
}

fuzz_target!(|input: (u64, Vec<u16>, u16, u16, u16)| {
    let (amount, weights, fee_bps, partner_bps, cut_bps) = input;
    check_split_n(amount, &weights);
    let mut normalized = weights.clone();
    normalized.truncate(MAX_RECIPIENTS);
    if let Some((last, rest)) = normalized.split_last_mut() {
        let mut left = 10_000u16;
        for w in rest.iter_mut() {
            *w %= left.saturating_add(1);
            left -= *w;
        }
        *last = left;
        check_split_n(amount, &normalized);
    }
    check_split_fees(amount, fee_bps, partner_bps, cut_bps);
    check_split_fees(amount, fee_bps % 101, partner_bps % 101, cut_bps % 10_001);
});
