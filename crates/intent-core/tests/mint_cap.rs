use intent_core::mint_cap::{
    charge, give_back, give_back_since, refund_outstanding, take_back, Limits, Refusal, Returned,
    Usage,
};

const LIMITS: Limits = Limits {
    max_per_order: 100,
    window_cap: 150,
    window_secs: 60,
    total_limit: 200,
};

const FRESH: Usage = Usage {
    window_start: 1_000,
    window_used: 0,
    outstanding: 0,
};

#[test]
fn a_charge_counts_against_the_window_and_the_total() {
    let next = charge(LIMITS, FRESH, 100, 1_010);
    assert_eq!(
        next,
        Ok(Usage {
            window_start: 1_000,
            window_used: 100,
            outstanding: 100,
        })
    );
}

#[test]
fn each_limit_refuses_with_its_own_reason() {
    assert_eq!(charge(LIMITS, FRESH, 101, 1_010), Err(Refusal::PerOrder));
    let busy = Usage {
        window_used: 100,
        ..FRESH
    };
    assert_eq!(charge(LIMITS, busy, 51, 1_010), Err(Refusal::Window));
    let full = Usage {
        outstanding: 150,
        ..FRESH
    };
    assert_eq!(charge(LIMITS, full, 51, 1_010), Err(Refusal::Total));
    let late = Usage {
        window_start: i64::MAX,
        ..FRESH
    };
    assert_eq!(charge(LIMITS, late, 1, 0), Err(Refusal::Overflow));
}

#[test]
fn a_window_resets_once_it_ends_and_a_zero_total_is_unlimited() {
    let busy = Usage {
        window_start: 1_000,
        window_used: 150,
        outstanding: 150,
    };
    let unlimited = Limits {
        total_limit: 0,
        ..LIMITS
    };
    assert_eq!(
        charge(unlimited, busy, 100, 1_060),
        Ok(Usage {
            window_start: 1_060,
            window_used: 100,
            outstanding: 250,
        })
    );
    assert_eq!(charge(unlimited, busy, 1, 1_059), Err(Refusal::Window));
}

#[test]
fn giving_back_counts_at_most_what_the_intent_holds() {
    assert_eq!(take_back(40, 100), (40, 0));
    assert_eq!(take_back(40, 10), (10, 30));
    assert_eq!(
        give_back(90, 40, 100),
        Ok(Returned {
            counted: 40,
            capped: 0,
            outstanding: 50,
        })
    );
    assert_eq!(give_back(10, 40, 100), Err(Refusal::Overflow));
}

#[test]
fn a_refund_lowers_only_a_cap_that_predates_the_intent() {
    assert_eq!(refund_outstanding(90, 40, 5, 5), 50);
    assert_eq!(refund_outstanding(90, 40, 5, 9), 50);
    assert_eq!(refund_outstanding(90, 40, 9, 5), 90);
    assert_eq!(refund_outstanding(10, 40, 5, 9), 0);
}

#[test]
fn a_fill_gives_back_only_to_a_cap_that_predates_the_intent() {
    let counted = Ok(Returned {
        counted: 40,
        capped: 0,
        outstanding: 50,
    });
    assert_eq!(give_back_since(90, 40, 100, 5, 5), counted);
    assert_eq!(give_back_since(90, 40, 100, 5, 9), counted);
    assert_eq!(
        give_back_since(90, 40, 10, 9, 5),
        Ok(Returned {
            counted: 10,
            capped: 30,
            outstanding: 90,
        })
    );
    assert_eq!(
        give_back_since(10, 40, 100, 9, 5),
        Ok(Returned {
            counted: 40,
            capped: 0,
            outstanding: 10,
        })
    );
    assert_eq!(give_back_since(10, 40, 100, 5, 9), Err(Refusal::Overflow));
}
