use core::cell::Cell;

use intent_core::fee::{release_settles, settles_after, split_fees};

#[kani::proof]
fn a_release_settles_exactly_when_the_rest_after_the_judge_splits() {
    let amount: u64 = kani::any();
    let judge_fee: u64 = kani::any();
    let verdict: bool = kani::any();
    let calls = Cell::new(0u8);
    let asked = Cell::new(0u64);
    let settles = settles_after(amount, judge_fee, |rest| {
        calls.set(calls.get() + 1);
        asked.set(rest);
        verdict
    });
    assert!(calls.get() <= 1);
    if judge_fee >= amount {
        assert!(!settles);
    } else {
        assert_eq!(calls.get(), 1);
        assert_eq!(asked.get(), amount - judge_fee);
        assert_eq!(settles, verdict);
    }
}

#[kani::proof]
fn a_release_the_judge_fee_swallows_never_settles_and_a_fee_free_one_always_does() {
    let amount: u64 = kani::any();
    let judge_fee: u64 = kani::any();
    let fee_bps: u16 = kani::any();
    let partner_bps: u16 = kani::any();
    let cut_bps: u16 = kani::any();
    if judge_fee >= amount {
        assert!(!release_settles(
            amount,
            judge_fee,
            fee_bps,
            partner_bps,
            cut_bps
        ));
    } else {
        assert!(release_settles(amount, judge_fee, 0, 0, cut_bps));
    }
}

#[kani::proof]
fn a_settling_release_never_pays_out_more_than_the_amount() {
    let amount: u64 = kani::any();
    let judge_fee: u64 = kani::any();
    let fee_bps: u16 = kani::any();
    let partner_bps: u16 = kani::any();
    let cut_bps: u16 = kani::any();
    kani::assume(judge_fee < amount);
    let Ok(fees) = split_fees(amount - judge_fee, fee_bps, partner_bps, cut_bps) else {
        return;
    };
    let paid = u128::from(judge_fee)
        + u128::from(fees.protocol)
        + u128::from(fees.partner)
        + u128::from(fees.net);
    assert!(paid <= u128::from(amount));
    assert_eq!(paid, u128::from(amount));
}
