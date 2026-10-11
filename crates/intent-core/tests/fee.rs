use intent_core::fee::{split_fee, split_fees, Fees, Split, BPS_DENOMINATOR};
use intent_core::Error;
use proptest::prelude::*;

#[test]
fn basis_points_are_parts_of_ten_thousand() {
    assert_eq!(BPS_DENOMINATOR, 10_000);
}

#[test]
fn fee_rounds_up_so_any_nonzero_rate_charges_something() {
    assert_eq!(split_fee(1, 1), Ok(Split { fee: 1, net: 0 }));
    assert_eq!(split_fee(10_000, 1), Ok(Split { fee: 1, net: 9_999 }));
    assert_eq!(split_fee(10_001, 1), Ok(Split { fee: 2, net: 9_999 }));
    assert_eq!(split_fee(400, 5), Ok(Split { fee: 1, net: 399 }));
    assert_eq!(
        split_fee(2_000_000, 100),
        Ok(Split {
            fee: 20_000,
            net: 1_980_000
        })
    );
}

#[test]
fn zero_rate_or_zero_amount_charges_nothing() {
    assert_eq!(
        split_fee(12_345, 0),
        Ok(Split {
            fee: 0,
            net: 12_345
        })
    );
    assert_eq!(split_fee(0, 100), Ok(Split { fee: 0, net: 0 }));
}

#[test]
fn full_rate_takes_everything_and_beyond_it_is_rejected() {
    assert_eq!(split_fee(777, 10_000), Ok(Split { fee: 777, net: 0 }));
    assert_eq!(split_fee(777, 10_001), Err(Error::InvalidParams));
    assert_eq!(
        split_fee(u64::MAX, 10_000),
        Ok(Split {
            fee: u64::MAX,
            net: 0
        })
    );
}

proptest! {
    #[test]
    fn fee_and_net_always_sum_to_amount(amount: u64, bps in 0u16..=10_000) {
        let split = split_fee(amount, bps);
        prop_assert!(split.is_ok());
        let got = split.unwrap_or(Split { fee: 0, net: 0 });
        prop_assert_eq!(got.fee.checked_add(got.net), Some(amount));
        let exact = u128::from(amount).wrapping_mul(u128::from(bps));
        let charged = u128::from(got.fee).wrapping_mul(10_000);
        prop_assert!(charged >= exact);
        prop_assert!(charged < exact.wrapping_add(10_000));
    }
}

#[test]
fn a_three_way_split_conserves_every_unit() {
    for (amount, fee, partner, cut) in [
        (0u64, 0u16, 0u16, 0u16),
        (2, 1, 1, 10_000),
        (400, 5, 25, 2_000),
        (10_001, 100, 100, 9_999),
        (u64::MAX, 100, 100, 10_000),
        (u64::MAX, 0, 0, 0),
        (12_345, 3, 0, 5_000),
    ] {
        let f = split_fees(amount, fee, partner, cut);
        assert!(f.is_ok(), "{amount} {fee} {partner} {cut}");
        let f = f.unwrap_or(Fees {
            protocol: 0,
            partner: 0,
            net: 0,
        });
        assert_eq!(
            f.protocol
                .checked_add(f.partner)
                .and_then(|v| v.checked_add(f.net)),
            Some(amount),
            "{amount} {fee} {partner} {cut}"
        );
    }
}

#[test]
fn the_fee_and_the_partner_share_round_up_and_the_cut_rounds_down() {
    assert_eq!(
        split_fees(400, 5, 25, 2_000),
        Ok(Fees {
            protocol: 1,
            partner: 1,
            net: 398
        })
    );
    assert_eq!(
        split_fees(10_000, 10, 50, 2_000),
        Ok(Fees {
            protocol: 20,
            partner: 40,
            net: 9_940
        })
    );
    assert_eq!(
        split_fees(10_001, 0, 1, 10_000),
        Ok(Fees {
            protocol: 2,
            partner: 0,
            net: 9_999
        })
    );
    assert_eq!(
        split_fees(10_000, 0, 30, 3_333),
        Ok(Fees {
            protocol: 9,
            partner: 21,
            net: 9_970
        })
    );
    assert_eq!(
        split_fee(400, 5).map(|s| s.fee),
        split_fees(400, 5, 0, 0).map(|f| f.protocol)
    );
}

#[test]
fn a_split_that_takes_more_than_the_amount_is_refused() {
    assert_eq!(split_fees(100, 10_000, 1, 0), Err(Error::InvalidParams));
    assert_eq!(split_fees(100, 5_000, 5_001, 0), Err(Error::InvalidParams));
    assert_eq!(split_fees(1, 1, 1, 0), Err(Error::InvalidParams));
    assert_eq!(
        split_fees(10_000, 0, 100, 20_000),
        Err(Error::InvalidParams)
    );
    assert_eq!(
        split_fees(10_000, 0, 100, 10_000),
        Ok(Fees {
            protocol: 100,
            partner: 0,
            net: 9_900
        })
    );
    assert_eq!(
        split_fees(100, 5_000, 5_000, 0),
        Ok(Fees {
            protocol: 50,
            partner: 50,
            net: 0
        })
    );
}

proptest! {
    #[test]
    fn the_three_way_split_never_loses_or_invents_a_unit(
        amount: u64,
        fee_bps in 0u16..=10_000,
        partner_bps in 0u16..=10_000,
        cut_bps in 0u16..=10_000,
    ) {
        prop_assume!(u32::from(fee_bps).checked_add(u32::from(partner_bps)).is_some_and(|s| s <= 10_000));
        let ceil = |bps: u16| u128::from(amount).checked_mul(u128::from(bps)).map(|p| p.div_ceil(10_000));
        let (Some(fee), Some(gross)) = (ceil(fee_bps), ceil(partner_bps)) else {
            return Err(TestCaseError::fail("a u64 times a u16 fits in u128"));
        };
        let owed = fee.checked_add(gross);
        match split_fees(amount, fee_bps, partner_bps, cut_bps) {
            Ok(f) => {
                let protocol_and_partner = u128::from(f.protocol).checked_add(u128::from(f.partner));
                prop_assert_eq!(
                    protocol_and_partner.and_then(|p| p.checked_add(u128::from(f.net))),
                    Some(u128::from(amount))
                );
                prop_assert_eq!(protocol_and_partner, owed);
                let kept = gross
                    .checked_mul(u128::from(cut_bps))
                    .and_then(|c| c.checked_div(10_000))
                    .and_then(|c| gross.checked_sub(c));
                prop_assert_eq!(Some(u128::from(f.partner)), kept);
                prop_assert!(u128::from(f.partner) <= gross);
            }
            Err(e) => {
                prop_assert!(e == Error::InvalidParams || e == Error::Overflow);
                prop_assert!(owed.is_some_and(|o| o > u128::from(amount)));
            }
        }
    }
}

#[test]
fn a_one_unit_amount_cannot_carry_both_fees() {
    assert_eq!(split_fees(1, 1, 1, 0), Err(Error::InvalidParams));
    assert_eq!(
        split_fees(1, 1, 0, 0),
        Ok(Fees {
            protocol: 1,
            partner: 0,
            net: 0
        })
    );
    assert_eq!(
        split_fees(2, 1, 1, 0),
        Ok(Fees {
            protocol: 1,
            partner: 1,
            net: 0
        })
    );
}
