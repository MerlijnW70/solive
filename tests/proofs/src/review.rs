use intent_core::claim::{arm_review, Claim, ReviewTerms, Slot, StakeTo, MAX_CLAIM_STAKE};
use intent_core::delivery::{cancel_ready, MAX_REVIEW_SECS, MIN_REVIEW_SECS};
use intent_core::Error;

fn any_claim() -> Claim {
    let mut worker = [0u8; 32];
    worker[0] = kani::any();
    Claim {
        worker,
        until: kani::any(),
        held: kani::any(),
        review_until: kani::any(),
        kill_fee: kani::any(),
    }
}

#[kani::proof]
#[kani::unwind(34)]
fn an_armed_review_holds_the_slot_at_every_time() {
    let c = any_claim();
    let now: i64 = kani::any();
    let slot = c.slot(now);
    if c.armed() {
        assert!(
            matches!(slot, Slot::Held { worker, until } if worker == c.worker && until == i64::MAX)
        );
        assert_eq!(slot.claimable(), Err(Error::ClaimHeld));
    } else {
        assert_eq!(slot, Slot::at(c.worker, c.until, now));
    }
}

#[kani::proof]
#[kani::unwind(34)]
fn the_kill_fee_is_paid_only_on_a_lapse_and_only_to_the_holder() {
    let c = any_claim();
    let now: i64 = kani::any();
    let open: bool = kani::any();
    let mut payees = [[0u8; 32]; 1];
    payees[0][0] = kani::any();
    let outcomes = [
        (c.on_settle(now, open).ok().flatten(), !open),
        (c.on_cancel(now).ok().flatten(), false),
        (c.on_release(&payees, now).ok().flatten(), false),
        (c.on_reject(now).ok(), false),
    ];
    for (payout, ended) in outcomes {
        let Some(payout) = payout else {
            continue;
        };
        if payout.kill_fee > 0 {
            assert!(c.armed());
            assert!(ended || now >= c.review_until);
            assert_eq!(payout.to, StakeTo::Worker);
            assert_eq!(payout.kill_fee, c.kill_fee);
            assert_eq!(Some(payout.amount), c.held.checked_add(c.kill_fee));
        } else {
            assert_eq!(payout.amount, c.held);
        }
        if c.armed() {
            assert_eq!(payout.to, StakeTo::Worker);
        }
    }
}

#[kani::proof]
#[kani::unwind(34)]
fn a_lapse_pays_the_whole_stake_and_fee_once_review_until_passes() {
    let c = any_claim();
    let now: i64 = kani::any();
    kani::assume(c.armed());
    let open: bool = kani::any();
    let settled = c.on_settle(now, open);
    let cancelled = c.on_cancel(now);
    if now >= c.review_until {
        if let Some(total) = c.held.checked_add(c.kill_fee) {
            for outcome in [settled, cancelled] {
                let payout = outcome.ok().flatten();
                assert!(payout.is_some_and(|p| p.amount == total && p.to == StakeTo::Worker));
            }
        }
    } else {
        assert_eq!(cancelled, Err(Error::ReviewPending));
        if open {
            assert_eq!(settled, Err(Error::ClaimHeld));
        }
    }
}

#[kani::proof]
#[kani::unwind(34)]
fn a_reject_returns_the_stake_only_before_review_until() {
    let c = any_claim();
    let now: i64 = kani::any();
    match c.on_reject(now) {
        Ok(p) => {
            assert!(c.armed() && now < c.review_until);
            assert_eq!((p.to, p.amount, p.kill_fee), (StakeTo::Worker, c.held, 0));
        }
        Err(e) => {
            assert_eq!(e, Error::ReviewLapsed);
            assert!(!c.armed() || now >= c.review_until);
        }
    }
}

#[kani::proof]
#[kani::unwind(34)]
fn a_review_arms_only_with_the_whole_window_before_expiry() {
    let review_secs: u32 = kani::any();
    let review_until: i64 = kani::any();
    let now: i64 = kani::any();
    let expires_at: i64 = kani::any();
    let until: i64 = kani::any();
    let mut worker = [0u8; 32];
    worker[0] = kani::any();
    let mut announcer = [0u8; 32];
    announcer[0] = kani::any();
    let raw = Slot::at(worker, until, now);
    if let Some(armed) = arm_review(review_secs, review_until, raw, announcer, now, expires_at) {
        assert!(review_secs > 0 && review_until == 0);
        assert_eq!(i128::from(armed), i128::from(now) + i128::from(review_secs));
        assert!(armed <= expires_at);
        assert!(armed != 0);
        assert!(matches!(raw, Slot::Held { worker, .. } if worker == announcer));
    }
}

#[kani::proof]
fn review_terms_accept_exactly_their_bounds() {
    let secs: u32 = kani::any();
    let fee: u64 = kani::any();
    let stake: u64 = kani::any();
    let rent: u64 = kani::any();
    let ok = (secs == 0 || (MIN_REVIEW_SECS..=MAX_REVIEW_SECS).contains(&secs))
        && (fee == 0 || (secs > 0 && stake > 0 && fee >= rent && fee <= MAX_CLAIM_STAKE));
    assert_eq!(ReviewTerms::new(secs, fee, stake, rent).is_ok(), ok);
}

#[kani::proof]
fn cancel_needs_a_request_and_its_notice() {
    let at: i64 = kani::any();
    let now: i64 = kani::any();
    let ready = cancel_ready(at, now);
    assert_eq!(ready.is_ok(), at != 0 && now >= at);
}
