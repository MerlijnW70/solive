use intent_core::kinds::{
    attested_result, dutch_auction, limit_order, swap_exact_in, Intent, Kind,
};
use intent_core::mandate::{worst_out, Limits, Usage, MANDATE_KINDS};
use intent_core::Error;
use proptest::prelude::*;

const NOW: i64 = 1_000;

fn limits() -> Limits {
    Limits {
        kinds: 0b1110,
        per_intent: 100,
        total: 250,
        max_intents: 3,
        max_ttl: 600,
        valid_until: 2_000,
        floor_out: 3,
        floor_in: 2,
        agent_fee: 0,
    }
}

fn swap(amount_in: u64, min_out: u64) -> Intent {
    Intent::SwapExactIn(swap_exact_in::Params { amount_in, min_out })
}

fn attested() -> Intent {
    Intent::AttestedResult(attested_result::Params {
        amount_in: 10,
        min_result: 1,
        max_result: 2,
        attestor: [7; 32],
    })
}

fn used(spent: u64, intents: u32) -> Usage {
    Usage { spent, intents }
}

#[test]
fn mandates_may_never_cover_attested_intents() {
    assert_eq!(
        MANDATE_KINDS,
        Kind::SwapExactIn.bit() | Kind::LimitOrder.bit() | Kind::DutchAuction.bit()
    );
    assert_eq!(MANDATE_KINDS, 0b1110);
    assert_eq!(worst_out(&attested()), None);
    let all = Limits {
        kinds: 0b1_1110,
        ..limits()
    };
    assert_eq!(all.validate(NOW), Err(Error::MandateInvalid));
    let forced = Limits {
        kinds: 0b1_0000,
        ..limits()
    };
    assert_eq!(
        forced.admit(Usage::default(), &attested(), NOW + 1, NOW),
        Err(Error::MandateKind)
    );
}

#[test]
fn sound_limits_validate_and_each_broken_one_is_refused() {
    assert_eq!(limits().validate(NOW), Ok(limits()));
    let edge = Limits {
        kinds: 0b10,
        per_intent: 1,
        total: 1,
        max_intents: 1,
        max_ttl: 1,
        valid_until: NOW + 1,
        floor_out: 1,
        floor_in: 1,
        agent_fee: 0,
    };
    assert_eq!(edge.validate(NOW), Ok(edge));
    let paid = Limits {
        agent_fee: 99,
        ..limits()
    };
    assert_eq!(paid.validate(NOW), Ok(paid));
    for broken in [
        Limits {
            kinds: 0,
            ..limits()
        },
        Limits {
            kinds: 0b1,
            ..limits()
        },
        Limits {
            kinds: 0b10_0010,
            ..limits()
        },
        Limits {
            per_intent: 0,
            ..limits()
        },
        Limits {
            agent_fee: 100,
            ..limits()
        },
        Limits {
            agent_fee: u64::MAX,
            ..limits()
        },
        Limits {
            total: 99,
            ..limits()
        },
        Limits {
            max_intents: 0,
            ..limits()
        },
        Limits {
            max_ttl: 0,
            ..limits()
        },
        Limits {
            max_ttl: -1,
            ..limits()
        },
        Limits {
            valid_until: NOW,
            ..limits()
        },
        Limits {
            floor_out: 0,
            ..limits()
        },
        Limits {
            floor_in: 0,
            ..limits()
        },
    ] {
        assert_eq!(
            broken.validate(NOW),
            Err(Error::MandateInvalid),
            "{broken:?}"
        );
    }
}

#[test]
fn worst_output_is_the_least_each_kind_can_settle_for() {
    assert_eq!(worst_out(&swap(10, 7)), Some(7));
    assert_eq!(
        worst_out(&Intent::LimitOrder(limit_order::Params {
            make_amount: 10,
            take_amount: 9
        })),
        Some(9)
    );
    assert_eq!(
        worst_out(&Intent::DutchAuction(dutch_auction::Params {
            amount_in: 10,
            start_out: 20,
            end_out: 15,
            start_ts: 0,
            end_ts: 5
        })),
        Some(15)
    );
}

#[test]
fn admission_counts_spend_and_intents() {
    let l = limits();
    assert_eq!(
        l.admit(Usage::default(), &swap(100, 150), NOW + 600, NOW),
        Ok(used(100, 1))
    );
    assert_eq!(
        l.admit(used(100, 1), &swap(100, 150), NOW + 1, NOW),
        Ok(used(200, 2))
    );
    assert_eq!(
        l.admit(used(200, 2), &swap(50, 75), NOW + 1, NOW),
        Ok(used(250, 3))
    );
}

#[test]
fn admission_stops_at_every_limit_exactly() {
    let l = limits();
    let ok = swap(100, 150);
    assert_eq!(
        l.admit(Usage::default(), &ok, NOW + 1, 1_999),
        Ok(used(100, 1))
    );
    assert_eq!(
        l.admit(Usage::default(), &ok, NOW + 1, 2_000),
        Err(Error::MandateExpired)
    );
    let swaps_only = Limits { kinds: 0b10, ..l };
    let limit = Intent::LimitOrder(limit_order::Params {
        make_amount: 10,
        take_amount: 15,
    });
    assert_eq!(
        swaps_only.admit(Usage::default(), &limit, NOW + 1, NOW),
        Err(Error::MandateKind)
    );
    assert_eq!(
        swaps_only.admit(Usage::default(), &ok, NOW + 1, NOW),
        Ok(used(100, 1))
    );
    assert_eq!(
        l.admit(Usage::default(), &ok, NOW + 601, NOW),
        Err(Error::MandateTtl)
    );
    assert_eq!(
        l.admit(Usage::default(), &ok, i64::MAX, i64::MIN),
        Err(Error::MandateTtl)
    );
    assert_eq!(
        l.admit(Usage::default(), &swap(101, 1_000), NOW + 1, NOW),
        Err(Error::MandateCap)
    );
    assert_eq!(
        l.admit(used(151, 0), &ok, NOW + 1, NOW),
        Err(Error::MandateBudget)
    );
    assert_eq!(l.admit(used(150, 0), &ok, NOW + 1, NOW), Ok(used(250, 1)));
    let roomy = Limits {
        total: u64::MAX,
        ..l
    };
    assert_eq!(
        roomy.admit(used(u64::MAX, 0), &ok, NOW + 1, NOW),
        Err(Error::MandateBudget)
    );
    assert_eq!(
        l.admit(used(0, 3), &ok, NOW + 1, NOW),
        Err(Error::MandateCount)
    );
    assert_eq!(l.admit(used(0, 2), &ok, NOW + 1, NOW), Ok(used(100, 3)));
    let many = Limits {
        max_intents: u32::MAX,
        ..l
    };
    assert_eq!(
        many.admit(used(0, u32::MAX), &ok, NOW + 1, NOW),
        Err(Error::MandateCount)
    );
    assert_eq!(
        l.admit(Usage::default(), &swap(100, 149), NOW + 1, NOW),
        Err(Error::MandatePrice)
    );
}

#[test]
fn the_agent_fee_counts_against_the_cap_the_budget_and_the_price() {
    let paid = Limits {
        agent_fee: 10,
        ..limits()
    };
    assert_eq!(
        paid.admit(Usage::default(), &swap(90, 150), NOW + 1, NOW),
        Ok(used(100, 1))
    );
    assert_eq!(
        paid.admit(Usage::default(), &swap(91, 1_000), NOW + 1, NOW),
        Err(Error::MandateCap)
    );
    assert_eq!(
        paid.admit(used(160, 0), &swap(80, 150), NOW + 1, NOW),
        Ok(used(250, 1))
    );
    assert_eq!(
        paid.admit(used(161, 0), &swap(80, 150), NOW + 1, NOW),
        Err(Error::MandateBudget)
    );
    assert_eq!(
        paid.admit(Usage::default(), &swap(90, 149), NOW + 1, NOW),
        Err(Error::MandatePrice)
    );
    let huge = Limits {
        per_intent: u64::MAX,
        total: u64::MAX,
        agent_fee: 1,
        ..limits()
    };
    assert_eq!(
        huge.admit(Usage::default(), &swap(u64::MAX, u64::MAX), NOW + 1, NOW),
        Err(Error::MandateCap)
    );
}

#[test]
fn the_price_floor_compares_without_overflow() {
    let wide = Limits {
        per_intent: u64::MAX,
        total: u64::MAX,
        floor_out: u64::MAX,
        floor_in: u64::MAX,
        ..limits()
    };
    assert_eq!(
        wide.admit(Usage::default(), &swap(u64::MAX, u64::MAX), NOW + 1, NOW),
        Ok(used(u64::MAX, 1))
    );
    assert_eq!(
        wide.admit(
            Usage::default(),
            &swap(u64::MAX, u64::MAX - 1),
            NOW + 1,
            NOW
        ),
        Err(Error::MandatePrice)
    );
}

proptest! {
    #[test]
    fn the_floor_admits_exactly_the_prices_at_or_above_it(
        amount_in in 1u64..=u64::MAX,
        min_out in 1u64..=u64::MAX,
        floor_out in 1u64..=u64::MAX,
        floor_in in 1u64..=u64::MAX,
    ) {
        let l = Limits { per_intent: u64::MAX, total: u64::MAX, floor_out, floor_in, ..limits() };
        let fair = u128::from(min_out).wrapping_mul(u128::from(floor_in)) >= u128::from(amount_in).wrapping_mul(u128::from(floor_out));
        let outcome = l.admit(Usage::default(), &swap(amount_in, min_out), NOW + 1, NOW);
        prop_assert_eq!(outcome.is_ok(), fair);
        if !fair {
            prop_assert_eq!(outcome, Err(Error::MandatePrice));
        }
    }
}

#[test]
fn mandated_intents_use_only_the_top_half_of_the_nonce_space() {
    use intent_core::mandate::{is_mandated_nonce, MANDATE_NONCE_BIT};
    assert_eq!(MANDATE_NONCE_BIT, 1 << 63);
    assert!(!is_mandated_nonce(0));
    assert!(!is_mandated_nonce(MANDATE_NONCE_BIT - 1));
    assert!(is_mandated_nonce(MANDATE_NONCE_BIT));
    assert!(is_mandated_nonce(u64::MAX));
}

#[test]
fn each_grant_owns_one_nonce_lane_and_no_other() {
    use intent_core::mandate::{in_lane, lane_of, LANE_MASK, MANDATE_NONCE_BIT, MAX_LANE_SERIAL};
    assert_eq!(lane_of(0), None);
    assert_eq!(lane_of(1), Some(MANDATE_NONCE_BIT | (1 << 32)));
    assert_eq!(lane_of(MAX_LANE_SERIAL), Some(LANE_MASK));
    assert_eq!(lane_of(MAX_LANE_SERIAL + 1), None);
    assert_eq!(lane_of(u64::MAX), None);
    assert_eq!(MAX_LANE_SERIAL, (1 << 31) - 1);
    assert_eq!(LANE_MASK, 0xffff_ffff_0000_0000);
    let lane = MANDATE_NONCE_BIT | (7 << 32);
    for low in [0u64, 1, 0x7fff_ffff, 0xffff_ffff] {
        assert!(in_lane(lane | low, 7));
        assert!(!in_lane(lane | low, 6));
        assert!(!in_lane(lane | low, 8));
        assert!(!in_lane((lane | low) & !MANDATE_NONCE_BIT, 7));
    }
    assert!(!in_lane(7 << 32, 7));
    assert!(!in_lane(MANDATE_NONCE_BIT | 5, 0));
    assert!(!in_lane(u64::MAX, MAX_LANE_SERIAL + 1));
    assert!(in_lane(u64::MAX, MAX_LANE_SERIAL));
}
