use intent_core::kinds::{dutch_auction, limit_order, swap_exact_in, Intent, Kind, ALL_KINDS_MASK};
use intent_core::{Error, PARAMS_LEN};
use proptest::prelude::*;

fn swap(amount_in: u64, min_out: u64) -> swap_exact_in::Params {
    swap_exact_in::Params { amount_in, min_out }
}

fn limit(make_amount: u64, take_amount: u64) -> limit_order::Params {
    limit_order::Params {
        make_amount,
        take_amount,
    }
}

fn dutch(start_out: u64, end_out: u64, start_ts: i64, end_ts: i64) -> dutch_auction::Params {
    dutch_auction::Params {
        amount_in: 50,
        start_out,
        end_out,
        start_ts,
        end_ts,
    }
}

fn with_byte(mut bytes: [u8; PARAMS_LEN], at: usize, v: u8) -> [u8; PARAMS_LEN] {
    if let Some(b) = bytes.get_mut(at) {
        *b = v;
    }
    bytes
}

#[test]
fn kind_codes_and_bits_are_fixed() {
    assert_eq!(Kind::try_from(0), Err(Error::UnknownKind));
    assert_eq!(Kind::try_from(1), Ok(Kind::SwapExactIn));
    assert_eq!(Kind::try_from(2), Ok(Kind::LimitOrder));
    assert_eq!(Kind::try_from(3), Ok(Kind::DutchAuction));
    assert_eq!(Kind::try_from(4), Ok(Kind::AttestedResult));
    assert_eq!(Kind::try_from(5), Err(Error::UnknownKind));
    assert_eq!(Kind::SwapExactIn as u8, 1);
    assert_eq!(Kind::LimitOrder as u8, 2);
    assert_eq!(Kind::DutchAuction as u8, 3);
    assert_eq!(Kind::AttestedResult as u8, 4);
    assert_eq!(Kind::SwapExactIn.bit(), 1 << 1);
    assert_eq!(Kind::LimitOrder.bit(), 1 << 2);
    assert_eq!(Kind::DutchAuction.bit(), 1 << 3);
    assert_eq!(Kind::AttestedResult.bit(), 1 << 4);
}

#[test]
fn all_kinds_mask_is_union_of_kind_bits() {
    assert_eq!(ALL_KINDS_MASK, 0b1_1110);
}

#[test]
fn dutch_auction_must_finish_by_expiry() {
    let d = Intent::DutchAuction(dutch(9, 3, 100, 200));
    assert!(d.fits_expiry(200));
    assert!(d.fits_expiry(i64::MAX));
    assert!(!d.fits_expiry(199));
    assert!(!d.fits_expiry(i64::MIN));
    for other in [
        Intent::SwapExactIn(swap(1, 1)),
        Intent::LimitOrder(limit(1, 1)),
    ] {
        assert!(other.fits_expiry(i64::MIN));
        assert!(other.fits_expiry(i64::MAX));
    }
}

#[test]
fn escrow_amount_is_the_input_side_of_each_kind() {
    assert_eq!(Intent::SwapExactIn(swap(11, 3)).escrow_amount(), 11);
    assert_eq!(Intent::LimitOrder(limit(13, 3)).escrow_amount(), 13);
    assert_eq!(
        Intent::DutchAuction(dutch_auction::Params {
            amount_in: 17,
            ..dutch(9, 3, 0, 1)
        })
        .escrow_amount(),
        17
    );
}

#[test]
fn enabled_in_tests_only_own_bit() {
    for kind in [
        Kind::SwapExactIn,
        Kind::LimitOrder,
        Kind::DutchAuction,
        Kind::AttestedResult,
    ] {
        assert!(kind.enabled_in(kind.bit()));
        assert!(kind.enabled_in(u64::MAX));
        assert!(!kind.enabled_in(0));
        assert!(!kind.enabled_in(!kind.bit()));
    }
}

#[test]
fn swap_layout_is_two_le_u64() -> Result<(), Error> {
    let bytes = swap(0x0102, 0x0304).encode()?;
    let mut want = [0u8; PARAMS_LEN];
    want = with_byte(want, 0, 0x02);
    want = with_byte(want, 1, 0x01);
    want = with_byte(want, 8, 0x04);
    want = with_byte(want, 9, 0x03);
    assert_eq!(bytes, want);
    assert_eq!(
        swap_exact_in::Params::decode(&bytes),
        Ok(swap(0x0102, 0x0304))
    );
    Ok(())
}

#[test]
fn swap_validation_rejects_each_zero_field() {
    assert_eq!(swap(1, 1).validate(), Ok(swap(1, 1)));
    assert_eq!(swap(0, 1).validate(), Err(Error::InvalidParams));
    assert_eq!(swap(1, 0).validate(), Err(Error::InvalidParams));
}

#[test]
fn swap_requires_exact_amount_in() {
    let p = swap(100, 90);
    assert_eq!(p.required_out(100), Ok(90));
    assert_eq!(p.required_out(99), Err(Error::AmountMismatch));
    assert_eq!(p.required_out(101), Err(Error::AmountMismatch));
}

#[test]
fn limit_layout_round_trips() -> Result<(), Error> {
    let p = limit(7, 11);
    let bytes = p.encode()?;
    assert_eq!(bytes, with_byte(with_byte([0u8; PARAMS_LEN], 0, 7), 8, 11));
    assert_eq!(limit_order::Params::decode(&bytes), Ok(p));
    Ok(())
}

#[test]
fn limit_validation_rejects_each_zero_field() {
    assert_eq!(limit(1, 1).validate(), Ok(limit(1, 1)));
    assert_eq!(limit(0, 1).validate(), Err(Error::InvalidParams));
    assert_eq!(limit(1, 0).validate(), Err(Error::InvalidParams));
}

#[test]
fn limit_required_out_rounds_up_proportionally() {
    let p = limit(1_000, 3_000);
    assert_eq!(p.required_out(1_000), Ok(3_000));
    assert_eq!(p.required_out(1), Ok(3));
    assert_eq!(p.required_out(0), Err(Error::AmountMismatch));
    assert_eq!(p.required_out(1_001), Err(Error::AmountMismatch));
    let q = limit(3, 2);
    assert_eq!(q.required_out(1), Ok(1));
    assert_eq!(q.required_out(2), Ok(2));
    assert_eq!(q.required_out(3), Ok(2));
}

#[test]
fn dutch_layout_round_trips() -> Result<(), Error> {
    let p = dutch(1_000, 400, -5, 200);
    let bytes = p.encode()?;
    let mut want = [0u8; PARAMS_LEN];
    want = with_byte(want, 0, 50);
    want = with_byte(want, 8, 0xe8);
    want = with_byte(want, 9, 0x03);
    want = with_byte(want, 16, 0x90);
    want = with_byte(want, 17, 0x01);
    for i in 24..32 {
        want = with_byte(want, i, 0xff);
    }
    want = with_byte(want, 24, 0xfb);
    want = with_byte(want, 32, 200);
    assert_eq!(bytes, want);
    assert_eq!(dutch_auction::Params::decode(&bytes), Ok(p));
    Ok(())
}

#[test]
fn dutch_validation_rejects_each_bad_field() {
    let ok = dutch(1_000, 400, 100, 200);
    assert_eq!(ok.validate(), Ok(ok));
    assert_eq!(
        dutch(400, 400, 100, 101).validate(),
        Ok(dutch(400, 400, 100, 101))
    );
    let zero_in = dutch_auction::Params { amount_in: 0, ..ok };
    assert_eq!(zero_in.validate(), Err(Error::InvalidParams));
    assert_eq!(
        dutch(1_000, 0, 100, 200).validate(),
        Err(Error::InvalidParams)
    );
    assert_eq!(
        dutch(399, 400, 100, 200).validate(),
        Err(Error::InvalidParams)
    );
    assert_eq!(
        dutch(1_000, 400, 200, 200).validate(),
        Err(Error::InvalidParams)
    );
    assert_eq!(
        dutch(1_000, 400, 201, 200).validate(),
        Err(Error::InvalidParams)
    );
}

#[test]
fn dutch_required_out_decays_linearly_and_clamps() {
    let p = dutch(1_000, 400, 100, 200);
    assert_eq!(p.required_out(50, i64::MIN), Ok(1_000));
    assert_eq!(p.required_out(50, 99), Ok(1_000));
    assert_eq!(p.required_out(50, 100), Ok(1_000));
    assert_eq!(p.required_out(50, 101), Ok(994));
    assert_eq!(p.required_out(50, 150), Ok(700));
    assert_eq!(p.required_out(50, 151), Ok(694));
    assert_eq!(p.required_out(50, 199), Ok(406));
    assert_eq!(p.required_out(50, 200), Ok(400));
    assert_eq!(p.required_out(50, 300), Ok(400));
    assert_eq!(p.required_out(50, i64::MAX), Ok(400));
    assert_eq!(p.required_out(49, 150), Err(Error::AmountMismatch));
    assert_eq!(p.required_out(51, 150), Err(Error::AmountMismatch));
}

#[test]
fn the_shortest_and_the_flat_auction_never_ask_less_than_their_end() {
    let shortest = dutch(1_000, 1, 7, 8);
    assert_eq!(shortest.required_out(50, 6), Ok(1_000));
    assert_eq!(shortest.required_out(50, 7), Ok(1_000));
    assert_eq!(shortest.required_out(50, 8), Ok(1));
    let flat = dutch(500, 500, 0, 1_000);
    for now in [i64::MIN, 0, 1, 500, 999, 1_000, i64::MAX] {
        assert_eq!(flat.required_out(50, now), Ok(500), "{now}");
    }
}

#[test]
fn dutch_rounds_decay_down_in_favor_of_maker() {
    let p = dutch(10, 7, 0, 3);
    assert_eq!(p.required_out(50, 1), Ok(9));
    assert_eq!(p.required_out(50, 2), Ok(8));
    let q = dutch(10, 9, 0, 3);
    assert_eq!(q.required_out(50, 1), Ok(10));
    assert_eq!(q.required_out(50, 2), Ok(10));
}

#[test]
fn dutch_handles_full_timestamp_range() {
    let p = dutch(u64::MAX, 1, i64::MIN, i64::MAX);
    assert_eq!(p.required_out(50, i64::MIN), Ok(u64::MAX));
    assert_eq!(p.required_out(50, i64::MAX), Ok(1));
    assert_eq!(p.required_out(50, 0), Ok(u64::MAX / 2 + 1));
}

#[test]
fn non_zero_trailing_bytes_are_rejected_for_every_kind() -> Result<(), Error> {
    let cases = [
        (Kind::SwapExactIn, swap(1, 1).encode()?, 16),
        (Kind::LimitOrder, limit(1, 1).encode()?, 16),
        (Kind::DutchAuction, dutch(2, 1, 0, 1).encode()?, 40),
    ];
    for (kind, bytes, tail) in cases {
        assert!(Intent::decode(kind as u8, &bytes).is_ok());
        for at in [tail, PARAMS_LEN - 1] {
            assert_eq!(
                Intent::decode(kind as u8, &with_byte(bytes, at, 1)),
                Err(Error::NonCanonical)
            );
        }
    }
    Ok(())
}

#[test]
fn decode_rejects_zero_params_and_unknown_kinds() {
    let zero = [0u8; PARAMS_LEN];
    for kind in 1..=4 {
        assert_eq!(Intent::decode(kind, &zero), Err(Error::InvalidParams));
    }
    assert_eq!(Intent::decode(0, &zero), Err(Error::UnknownKind));
    assert_eq!(Intent::decode(5, &zero), Err(Error::UnknownKind));
}

#[test]
fn intent_dispatches_to_its_kind() -> Result<(), Error> {
    let cases = [
        Intent::SwapExactIn(swap(50, 7)),
        Intent::LimitOrder(limit(50, 7)),
        Intent::DutchAuction(dutch(7, 7, 0, 1)),
    ];
    for (intent, kind) in
        cases
            .into_iter()
            .zip([Kind::SwapExactIn, Kind::LimitOrder, Kind::DutchAuction])
    {
        assert_eq!(intent.kind(), kind);
        let bytes = intent.encode()?;
        assert_eq!(Intent::decode(kind as u8, &bytes), Ok(intent));
        assert_eq!(intent.required_out(50, 0), Ok(7));
        assert_eq!(intent.settle(50, 7, 0), Ok(()));
        assert_eq!(intent.settle(50, u64::MAX, 0), Ok(()));
        assert_eq!(intent.settle(50, 6, 0), Err(Error::InsufficientOutput));
        assert_eq!(intent.settle(51, 7, 0), Err(Error::AmountMismatch));
    }
    assert_eq!(
        Intent::DutchAuction(dutch(1_000, 400, 100, 200)).required_out(50, 150),
        Ok(700)
    );
    assert_eq!(Intent::LimitOrder(limit(4, 3)).required_out(2, 0), Ok(2));
    Ok(())
}

#[test]
fn settle_delta_judges_the_balance_increase_not_the_balances() {
    let intent = Intent::SwapExactIn(swap(50, 7));
    assert_eq!(intent.settle_delta(50, 100, 107, 0), Ok(7));
    assert_eq!(intent.settle_delta(50, 100, 200, 0), Ok(100));
    assert_eq!(intent.settle_delta(50, 0, 7, 0), Ok(7));
    assert_eq!(
        intent.settle_delta(50, 100, 106, 0),
        Err(Error::InsufficientOutput)
    );
    assert_eq!(
        intent.settle_delta(50, 100, 100, 0),
        Err(Error::InsufficientOutput)
    );
    assert_eq!(intent.settle_delta(50, 100, 99, 0), Err(Error::Overflow));
    assert_eq!(
        intent.settle_delta(49, 100, 107, 0),
        Err(Error::AmountMismatch)
    );
    let auction = Intent::DutchAuction(dutch(1_000, 400, 100, 200));
    assert_eq!(auction.settle_delta(50, 0, 700, 150), Ok(700));
    assert_eq!(
        auction.settle_delta(50, 0, 699, 150),
        Err(Error::InsufficientOutput)
    );
}

proptest! {
    #[test]
    fn limit_settle_matches_cross_multiplication(
        make in 1u64.., take in 1u64.., amount_in in 1u64.., out: u64,
    ) {
        let intent = Intent::LimitOrder(limit(make, take));
        let got = intent.settle(amount_in, out, 0);
        if amount_in > make {
            prop_assert_eq!(got, Err(Error::AmountMismatch));
        } else {
            let lhs = u128::from(out).wrapping_mul(u128::from(make));
            let rhs = u128::from(take).wrapping_mul(u128::from(amount_in));
            let want = if lhs >= rhs { Ok(()) } else { Err(Error::InsufficientOutput) };
            prop_assert_eq!(got, want);
        }
    }

    #[test]
    fn dutch_required_out_is_monotone_and_bounded(
        start_out: u64, end_out in 1u64.., start_ts: i64, end_ts: i64, a: i64, b: i64,
    ) {
        let p = dutch(start_out.max(end_out), end_out, start_ts.min(end_ts), start_ts.max(end_ts));
        prop_assume!(p.validate().is_ok());
        let (lo, hi) = (a.min(b), a.max(b));
        let early = p.required_out(50, lo);
        let late = p.required_out(50, hi);
        prop_assert!(matches!((early, late), (Ok(e), Ok(l)) if e >= l));
        prop_assert!(matches!(early, Ok(e) if e <= p.start_out && e >= p.end_out));
    }

    #[test]
    fn decode_never_panics_and_round_trips(kind: u8, bytes in prop::array::uniform32(any::<u8>())) {
        let mut params = [0u8; PARAMS_LEN];
        for (dst, src) in params.iter_mut().zip(bytes) {
            *dst = src;
        }
        if let Ok(intent) = Intent::decode(kind, &params) {
            prop_assert_eq!(intent.kind() as u8, kind);
            prop_assert_eq!(intent.encode(), Ok(params));
        }
    }
}
