use intent_core::fee::{split_fees, Fees};
use intent_core::kinds::dutch_auction;
use intent_core::mint_cap::{charge, Limits, Usage};
use proptest::prelude::*;

const BPS: u128 = 10_000;

fn fee_terms() -> impl Strategy<Value = (u16, u16, u16)> {
    (0u16..=300, 0u16..=100, 0u16..=10_000)
}

fn fee_leg(amount: u64, fee_bps: u16) -> Option<u128> {
    split_fees(amount, fee_bps, 0, 0)
        .ok()
        .map(|f| u128::from(f.protocol))
}

fn partner_leg(amount: u64, partner_bps: u16) -> Option<u128> {
    split_fees(amount, 0, partner_bps, 0)
        .ok()
        .map(|f| u128::from(f.partner))
}

proptest! {
    #[test]
    fn catalog_splitting_an_order_never_lowers_the_fee_or_raises_the_owners_net(
        first in 1u64..=9_223_372_036_854_775_807,
        second in 1u64..=9_223_372_036_854_775_807,
        (fee_bps, partner_bps, cut_bps) in fee_terms(),
    ) {
        let whole = first.checked_add(second).ok_or_else(|| TestCaseError::fail("halves fit"))?;
        let parts = (
            split_fees(first, fee_bps, partner_bps, cut_bps),
            split_fees(second, fee_bps, partner_bps, cut_bps),
            split_fees(whole, fee_bps, partner_bps, cut_bps),
        );
        let (Ok(a), Ok(b), Ok(w)) = parts else {
            return Ok(());
        };
        let fee_parts = fee_leg(first, fee_bps).zip(fee_leg(second, fee_bps));
        let fee_whole = fee_leg(whole, fee_bps);
        prop_assert!(fee_parts.zip(fee_whole).is_some_and(|((x, y), z)| x.checked_add(y).is_some_and(|s| s >= z)));
        let nets = u128::from(a.net).checked_add(u128::from(b.net));
        prop_assert!(nets.is_some_and(|n| n <= u128::from(w.net)));
        let charged = |f: Fees| u128::from(f.protocol).checked_add(u128::from(f.partner));
        let split_charge = charged(a).zip(charged(b)).and_then(|(x, y)| x.checked_add(y));
        prop_assert!(split_charge.zip(charged(w)).is_some_and(|(s, c)| s >= c));
    }

    #[test]
    fn catalog_each_fee_leg_rounds_against_the_payer_by_less_than_one_unit(
        amount: u64,
        (fee_bps, partner_bps, cut_bps) in fee_terms(),
    ) {
        let Ok(f) = split_fees(amount, fee_bps, partner_bps, cut_bps) else {
            return Ok(());
        };
        let exact_fee = u128::from(amount).checked_mul(u128::from(fee_bps));
        let exact_gross = u128::from(amount).checked_mul(u128::from(partner_bps));
        let gross = partner_leg(amount, partner_bps);
        let fee = fee_leg(amount, fee_bps);
        let legs = fee.zip(gross).and_then(|(x, y)| x.checked_add(y));
        prop_assert_eq!(legs, u128::from(f.protocol).checked_add(u128::from(f.partner)));
        prop_assert!(fee.zip(exact_fee).is_some_and(|(c, e)| c.checked_mul(BPS).is_some_and(|s| s >= e && s < e.saturating_add(BPS))));
        prop_assert!(gross.zip(exact_gross).is_some_and(|(c, e)| c.checked_mul(BPS).is_some_and(|s| s >= e && s < e.saturating_add(BPS))));
        let exact_cut = gross.and_then(|g| g.checked_mul(u128::from(cut_bps)));
        let cut = gross.and_then(|g| g.checked_sub(u128::from(f.partner)));
        prop_assert!(cut.zip(exact_cut).is_some_and(|(c, e)| c.checked_mul(BPS).is_some_and(|s| s <= e && s.saturating_add(BPS) > e)));
    }

    #[test]
    fn catalog_a_dutch_price_never_drops_below_the_exact_linear_price(
        end_out in 1u64..,
        spread: u64,
        start_ts: i64,
        length in 1u64..,
        at: i64,
    ) {
        let start_out = end_out.saturating_add(spread);
        let Some(end_ts) = i128::from(start_ts)
            .checked_add(i128::from(length))
            .and_then(|e| i64::try_from(e).ok())
        else {
            return Ok(());
        };
        let p = dutch_auction::Params { amount_in: 1, start_out, end_out, start_ts, end_ts };
        let Ok(required) = p.required_out(1, at) else {
            return Err(TestCaseError::fail("a valid auction prices every moment"));
        };
        let clamped = at.max(start_ts).min(end_ts);
        let elapsed = u128::from(clamped.abs_diff(start_ts));
        let span = u128::from(end_ts.abs_diff(start_ts));
        let drop = u128::from(start_out.abs_diff(end_out));
        let exact = u128::from(start_out)
            .checked_mul(span)
            .zip(drop.checked_mul(elapsed))
            .and_then(|(top, fall)| top.checked_sub(fall));
        let charged = u128::from(required).checked_mul(span);
        prop_assert!(exact.zip(charged).is_some_and(|(e, c)| c >= e && c < e.saturating_add(span)));
        prop_assert!(required >= end_out && required <= start_out);
    }

    #[test]
    fn catalog_a_mint_cap_window_resets_at_its_last_second_and_not_before(
        window_secs in 60u32..,
        window_start in -1_000_000_000i64..1_000_000_000,
        used in 1u64..1_000,
    ) {
        let limits = Limits { max_per_order: 1_000, window_cap: used.saturating_add(1), window_secs, total_limit: 0 };
        let usage = Usage { window_start, window_used: used, outstanding: 0 };
        let ends = window_start
            .checked_add(i64::from(window_secs))
            .ok_or_else(|| TestCaseError::fail("window fits"))?;
        let last = ends.checked_sub(1).ok_or_else(|| TestCaseError::fail("window ends after it starts"))?;
        prop_assert!(charge(limits, usage, 2, last).is_err());
        let reset = charge(limits, usage, 2, ends);
        prop_assert!(reset.is_ok_and(|u| u.window_start == ends && u.window_used == 2));
    }
}
