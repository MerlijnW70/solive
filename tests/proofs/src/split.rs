use intent_core::bounty::split_n;
use intent_core::fee::split_fees;

const D: u16 = 10_000;

fn valid_bps() -> (u16, u16, u16) {
    let fee_bps: u16 = kani::any();
    let partner_bps: u16 = kani::any();
    let cut_bps: u16 = kani::any();
    kani::assume(u32::from(fee_bps) + u32::from(partner_bps) <= u32::from(D));
    kani::assume(cut_bps <= D);
    (fee_bps, partner_bps, cut_bps)
}

#[kani::proof]
#[kani::unwind(4)]
fn split_n_hands_out_exactly_the_amount_to_up_to_three_recipients() {
    let amount: u64 = kani::any();
    let weights: [u16; 3] = kani::any();
    let len: usize = kani::any();
    kani::assume(len >= 1 && len <= 3);
    let chosen = &weights[..len];
    let sum = chosen.iter().map(|&w| u32::from(w)).sum::<u32>();
    let Ok(plan) = split_n(amount, chosen) else {
        return;
    };
    assert!(sum == u32::from(D));
    let shares = plan.as_slice();
    assert!(shares.len() == len);
    let total = shares.iter().map(|&s| u128::from(s)).sum::<u128>();
    assert!(total == u128::from(amount));
    assert!(plan.total() == amount);
}

#[kani::proof]
#[kani::unwind(4)]
fn split_n_refuses_weights_that_do_not_sum_to_ten_thousand() {
    let amount: u64 = kani::any();
    let weights: [u16; 3] = kani::any();
    let len: usize = kani::any();
    kani::assume(len <= 3);
    let chosen = &weights[..len];
    let sum = chosen.iter().map(|&w| u32::from(w)).sum::<u32>();
    kani::assume(sum != u32::from(D));
    assert!(split_n(amount, chosen).is_err());
}

#[kani::proof]
fn split_fees_conserves_the_amount_and_stays_within_its_bounds() {
    let amount: u64 = kani::any();
    let (fee_bps, partner_bps, cut_bps) = valid_bps();
    let Ok(fees) = split_fees(amount, fee_bps, partner_bps, cut_bps) else {
        return;
    };
    let a = u128::from(amount);
    let protocol = u128::from(fees.protocol);
    let partner = u128::from(fees.partner);
    let net = u128::from(fees.net);
    assert!(net + protocol + partner == a);
    assert!(protocol <= a && partner <= a && net <= a);
    assert!(protocol + partner <= a);
}

#[kani::proof]
fn split_fees_without_a_partner_pays_the_partner_nothing() {
    let amount: u64 = kani::any();
    let (fee_bps, _, cut_bps) = valid_bps();
    if let Ok(fees) = split_fees(amount, fee_bps, 0, cut_bps) {
        assert!(fees.partner == 0);
        assert!(u128::from(fees.net) + u128::from(fees.protocol) == u128::from(amount));
    }
}

#[kani::proof]
fn split_fees_without_fees_hands_the_whole_amount_to_net() {
    let amount: u64 = kani::any();
    let cut_bps: u16 = kani::any();
    let fees = split_fees(amount, 0, 0, cut_bps);
    assert!(matches!(fees, Ok(f) if f.net == amount && f.protocol == 0 && f.partner == 0));
}
