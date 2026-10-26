use intent_core::claim::{serve_until, Terms, MAX_CLAIM_SECS};
use intent_core::clock::{after, elapsed};
use intent_core::kinds::{swap_exact_in, Intent};
use intent_core::mandate::{Limits, Usage};
use intent_core::Error;
use proptest::prelude::*;

const YEAR: i64 = 365 * 86_400;
const HOUR: u32 = 3_600;
const FAR: [i64; 4] = [
    i64::MAX,
    i64::MAX - YEAR - 1,
    i64::MAX - YEAR,
    i64::MAX - YEAR + 1,
];

#[test]
fn a_window_passes_exactly_at_its_edge_even_where_the_edge_is_past_the_clock() {
    assert!(!elapsed(1_000 + YEAR - 1, 1_000, YEAR));
    assert!(elapsed(1_000 + YEAR, 1_000, YEAR));
    let last = i64::MAX - YEAR;
    assert!(!elapsed(i64::MAX - 1, last, YEAR));
    assert!(elapsed(i64::MAX, last, YEAR));
    assert!(!elapsed(i64::MAX, last + 1, YEAR));
    assert!(!elapsed(i64::MAX, i64::MAX, YEAR));
    assert!(!elapsed(i64::MIN, i64::MIN, 1));
    assert!(elapsed(i64::MIN, i64::MIN, 0));
    assert_eq!(
        after(i64::MAX, YEAR),
        i128::from(i64::MAX) + i128::from(YEAR)
    );
    assert_eq!(after(i64::MIN, -1), i128::from(i64::MIN) - 1);
}

#[test]
fn a_claim_on_a_far_escrow_runs_its_term_or_is_refused_never_overflowing() -> Result<(), Error> {
    let terms = Terms::new(HOUR, 0)?;
    for expires_at in FAR {
        assert_eq!(terms.until(1_000, HOUR, expires_at)?, 4_600);
        let latest = expires_at - 3_600;
        assert_eq!(terms.until(latest, HOUR, expires_at)?, expires_at);
        assert_eq!(
            terms.until(latest + 1, HOUR, expires_at),
            Err(Error::ClaimTerms),
            "{expires_at}"
        );
        assert_eq!(terms.until(latest + 1, HOUR - 1, expires_at)?, expires_at);
    }
    assert_eq!(terms.until(i64::MAX, 1, i64::MAX), Err(Error::ClaimTerms));
    Ok(())
}

#[test]
fn a_stand_by_holds_for_its_time_and_never_past_the_escrow() {
    for expires_at in FAR {
        assert_eq!(serve_until(1_000, HOUR, expires_at), 4_600);
        assert_eq!(
            serve_until(expires_at - 3_600, HOUR, expires_at),
            expires_at
        );
        assert_eq!(serve_until(expires_at - 100, HOUR, expires_at), expires_at);
        assert_eq!(
            serve_until(expires_at - 3_601, HOUR, expires_at),
            expires_at - 1
        );
    }
    assert_eq!(serve_until(i64::MAX, MAX_CLAIM_SECS, i64::MAX), i64::MAX);
    assert_eq!(serve_until(i64::MIN, 1, i64::MAX), i64::MIN + 1);
}

#[test]
fn a_mandate_lifetime_is_measured_exactly_on_the_whole_clock() {
    let limits = Limits {
        kinds: 0b10,
        per_intent: 10,
        total: 10,
        max_intents: 1,
        max_ttl: i64::MAX,
        valid_until: i64::MAX,
        floor_out: 1,
        floor_in: 1,
        agent_fee: 0,
    };
    let swap = Intent::SwapExactIn(swap_exact_in::Params {
        amount_in: 10,
        min_out: 10,
    });
    assert_eq!(
        limits.admit(Usage::default(), &swap, i64::MAX, -1),
        Err(Error::MandateTtl)
    );
    assert!(limits.admit(Usage::default(), &swap, i64::MAX, 0).is_ok());
    let year = Limits {
        max_ttl: YEAR,
        ..limits
    };
    assert!(year
        .admit(Usage::default(), &swap, i64::MAX, i64::MAX - YEAR)
        .is_ok());
    assert_eq!(
        year.admit(Usage::default(), &swap, i64::MAX, i64::MAX - YEAR - 1),
        Err(Error::MandateTtl)
    );
}

proptest! {
    #[test]
    fn elapsed_is_the_exact_comparison(now: i64, from: i64, secs: i64) {
        let exact = i128::from(now) >= i128::from(from).saturating_add(i128::from(secs));
        prop_assert_eq!(elapsed(now, from, secs), exact);
    }

    #[test]
    fn serve_until_is_the_exact_earlier_time(now: i64, secs: u32, expires_at: i64) {
        let exact = i128::from(now)
            .saturating_add(i128::from(secs))
            .min(i128::from(expires_at));
        prop_assert_eq!(i128::from(serve_until(now, secs, expires_at)), exact);
    }
}
