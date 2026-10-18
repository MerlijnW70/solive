use intent_core::claim::{
    stake_on_cancel, stake_on_release, stake_on_settle, Cooldown, Slot, StakeTo, Terms,
    MAX_CLAIM_SECS, MAX_CLAIM_STAKE,
};
use intent_core::Error;
use proptest::prelude::*;

const WORKER: [u8; 32] = [7; 32];
const OTHER: [u8; 32] = [8; 32];
const NOW: i64 = 1_700_000_000;

#[test]
fn terms_bound_the_claim_length_and_the_stake() -> Result<(), Error> {
    assert!(Terms::new(MAX_CLAIM_SECS, MAX_CLAIM_STAKE).is_ok());
    assert!(Terms::new(1, 0).is_ok());
    for (secs, stake) in [(0, 1), (MAX_CLAIM_SECS + 1, 1), (60, MAX_CLAIM_STAKE + 1)] {
        assert_eq!(
            Terms::new(secs, stake),
            Err(Error::ClaimTerms),
            "{secs} {stake}"
        );
    }
    let terms = Terms::new(3_600, 5)?;
    assert_eq!((terms.max_secs(), terms.stake()), (3_600, 5));
    Ok(())
}

#[test]
fn a_claim_lasts_at_most_the_terms_and_never_past_the_escrow() -> Result<(), Error> {
    let terms = Terms::new(3_600, 0)?;
    assert_eq!(terms.until(NOW, 3_600, NOW + 3_600)?, NOW + 3_600);
    assert_eq!(terms.until(NOW, 1, NOW + 10)?, NOW + 1);
    for (secs, expires) in [(0, NOW + 10), (3_601, NOW + 10_000), (11, NOW + 10)] {
        assert_eq!(
            terms.until(NOW, secs, expires),
            Err(Error::ClaimTerms),
            "{secs}"
        );
    }
    assert_eq!(terms.until(i64::MAX, 1, i64::MAX), Err(Error::Overflow));
    Ok(())
}

#[test]
fn a_slot_is_free_held_until_its_deadline_then_lapsed() {
    assert_eq!(Slot::at([0; 32], NOW + 10, NOW), Slot::Free);
    assert_eq!(
        Slot::at(WORKER, NOW + 1, NOW),
        Slot::Held {
            worker: WORKER,
            until: NOW + 1
        }
    );
    assert_eq!(Slot::at(WORKER, NOW, NOW), Slot::Lapsed { worker: WORKER });
    assert_eq!(Slot::at(WORKER, NOW, NOW).claimable(), Ok(()));
    assert_eq!(Slot::Free.claimable(), Ok(()));
    assert_eq!(
        Slot::at(WORKER, NOW + 1, NOW).claimable(),
        Err(Error::ClaimHeld)
    );
}

#[test]
fn a_held_claim_lets_only_its_worker_be_paid_and_returns_the_stake() {
    let held = Slot::at(WORKER, NOW + 1, NOW);
    assert_eq!(held.may_pay(&[WORKER]), Ok(()));
    assert_eq!(held.may_pay(&[OTHER, WORKER]), Ok(()));
    assert_eq!(held.may_pay(&[OTHER]), Err(Error::ClaimHeld));
    assert_eq!(stake_on_release(held, &[WORKER]), Some(StakeTo::Worker));
    let lapsed = Slot::at(WORKER, NOW, NOW);
    assert_eq!(lapsed.may_pay(&[OTHER]), Ok(()));
    assert_eq!(stake_on_release(lapsed, &[OTHER]), Some(StakeTo::Owner));
    assert_eq!(stake_on_release(lapsed, &[WORKER]), Some(StakeTo::Owner));
    assert_eq!(stake_on_release(lapsed, &[WORKER, OTHER]), Some(StakeTo::Owner));
    assert_eq!(Slot::Free.may_pay(&[OTHER]), Ok(()));
    assert_eq!(stake_on_release(Slot::Free, &[OTHER]), None);
}

#[test]
fn a_cancel_refunds_a_held_claim_and_forfeits_a_lapsed_one() {
    assert_eq!(stake_on_cancel(Slot::Free), None);
    assert_eq!(
        stake_on_cancel(Slot::Held {
            worker: WORKER,
            until: NOW + 1
        }),
        Some(StakeTo::Worker)
    );
    assert_eq!(
        stake_on_cancel(Slot::Lapsed { worker: WORKER }),
        Some(StakeTo::Owner)
    );
}

#[test]
fn a_worker_that_dropped_waits_for_its_term_while_everyone_else_may_claim() {
    let cooldown = Cooldown {
        worker: WORKER,
        until: NOW + 10,
    };
    assert_eq!(
        cooldown.check(Slot::Free, WORKER, NOW + 9),
        Err(Error::ClaimCooldown)
    );
    assert_eq!(cooldown.check(Slot::Free, WORKER, NOW + 10), Ok(()));
    assert_eq!(cooldown.check(Slot::Free, OTHER, NOW), Ok(()));
    assert_eq!(
        cooldown.check(Slot::Lapsed { worker: OTHER }, WORKER, NOW),
        Ok(())
    );
    assert_eq!(
        cooldown.check(
            Slot::Held {
                worker: OTHER,
                until: NOW + 5
            },
            OTHER,
            NOW
        ),
        Err(Error::ClaimHeld)
    );
    let none = Cooldown {
        worker: [0; 32],
        until: NOW + 10,
    };
    assert_eq!(none.check(Slot::Free, [0; 32], NOW), Ok(()));
}

#[test]
fn settling_refunds_a_worker_the_escrow_failed_and_forfeits_a_lapsed_claim() {
    let held = Slot::at(WORKER, NOW + 1, NOW);
    assert_eq!(stake_on_settle(held, true), Err(Error::ClaimHeld));
    assert_eq!(stake_on_settle(held, false), Ok(Some(StakeTo::Worker)));
    let lapsed = Slot::at(WORKER, NOW, NOW);
    assert_eq!(stake_on_settle(lapsed, true), Ok(Some(StakeTo::Owner)));
    assert_eq!(stake_on_settle(lapsed, false), Ok(Some(StakeTo::Owner)));
    assert_eq!(stake_on_settle(Slot::Free, true), Ok(None));
}

proptest! {
    #[test]
    fn a_held_claim_never_pays_anyone_else(
        until in (NOW + 1)..(NOW + 1_000_000),
        payees in proptest::collection::vec(any::<[u8; 32]>(), 1..8),
    ) {
        let held = Slot::at(WORKER, until, NOW);
        let allowed = held.may_pay(&payees).is_ok();
        prop_assert_eq!(allowed, payees.contains(&WORKER));
        if allowed {
            prop_assert_eq!(stake_on_release(held, &payees), Some(StakeTo::Worker));
        }
    }

    #[test]
    fn a_claim_never_outlives_its_terms_or_its_escrow(
        max in 1u32..=MAX_CLAIM_SECS,
        secs in 0u32..=MAX_CLAIM_SECS,
        left in 0i64..2_000_000,
    ) {
        let terms = Terms::new(max, 0).map_err(|e| TestCaseError::fail(format!("{e:?}")))?;
        match terms.until(NOW, secs, NOW.saturating_add(left)) {
            Ok(until) => {
                prop_assert!(secs >= 1 && secs <= max);
                prop_assert_eq!(until, NOW.saturating_add(i64::from(secs)));
                prop_assert!(until <= NOW.saturating_add(left));
            }
            Err(error) => {
                prop_assert_eq!(error, Error::ClaimTerms);
                prop_assert!(secs == 0 || secs > max || NOW.saturating_add(i64::from(secs)) > NOW.saturating_add(left));
            }
        }
    }
}
