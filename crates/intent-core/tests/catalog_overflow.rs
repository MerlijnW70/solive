use intent_core::claim::{Line, Terms, MAX_CLAIM_SECS, MAX_CLAIM_STAKE};
use intent_core::kinds::{swap_exact_in, Intent};
use intent_core::mandate::{Limits, Usage};
use intent_core::mint_cap::{
    charge, give_back_since, Limits as CapLimits, Refusal, Usage as CapUsage,
};
use intent_core::Error;
use proptest::prelude::*;

fn swap(amount_in: u64) -> Intent {
    Intent::SwapExactIn(swap_exact_in::Params {
        amount_in,
        min_out: u64::MAX,
    })
}

fn open_limits(per_intent: u64, total: u64, agent_fee: u64, max_ttl: i64) -> Limits {
    Limits {
        kinds: 0b10,
        per_intent,
        total,
        max_intents: u32::MAX,
        max_ttl,
        valid_until: i64::MAX,
        floor_out: 1,
        floor_in: 1,
        agent_fee,
    }
}

proptest! {
    #[test]
    fn catalog_a_claim_deadline_is_exact_or_refused_on_the_whole_clock(
        max_secs in 1u32..=MAX_CLAIM_SECS,
        now: i64,
        secs: u32,
        expires_at: i64,
    ) {
        let terms = Terms::new(max_secs, MAX_CLAIM_STAKE);
        prop_assert!(terms.is_ok());
        let Ok(terms) = terms else {
            return Err(TestCaseError::fail("sound terms"));
        };
        let exact = i128::from(now).checked_add(i128::from(secs));
        let fits = secs != 0
            && secs <= max_secs
            && exact.is_some_and(|e| e <= i128::from(i64::MAX) && e <= i128::from(expires_at));
        match terms.until(now, secs, expires_at) {
            Ok(until) => {
                prop_assert!(fits);
                prop_assert_eq!(Some(i128::from(until)), exact);
            }
            Err(e) => {
                prop_assert!(!fits);
                prop_assert_eq!(e, Error::ClaimTerms);
            }
        }
    }

    #[test]
    fn catalog_claim_terms_refuse_any_stake_above_the_ceiling(max_secs: u32, stake: u64) {
        let sound = max_secs != 0 && max_secs <= MAX_CLAIM_SECS && stake <= MAX_CLAIM_STAKE;
        prop_assert_eq!(Terms::new(max_secs, stake).is_ok(), sound);
    }

    #[test]
    fn catalog_a_line_never_wraps_its_tail_or_serves_past_it(head: u32, tail: u32) {
        let mut line = Line { head: head.min(tail), tail };
        let before = line;
        match line.join() {
            Ok(seq) => {
                prop_assert_eq!(seq, before.tail);
                prop_assert_eq!(Some(line.tail), before.tail.checked_add(1));
            }
            Err(e) => {
                prop_assert_eq!(e, Error::Overflow);
                prop_assert_eq!(before.tail, u32::MAX);
                prop_assert_eq!(line, before);
            }
        }
        let mut passing = before;
        let mut served = 0u32;
        while let Some(seq) = passing.pass() {
            prop_assert!(seq < before.tail);
            served = served.checked_add(1).ok_or_else(|| TestCaseError::fail("served wrapped"))?;
            if served > 64 {
                break;
            }
        }
        prop_assert!(passing.head <= before.tail);
    }

    #[test]
    fn catalog_a_mint_cap_charge_adds_exactly_or_refuses(
        max_per_order: u64,
        window_cap: u64,
        window_secs: u32,
        total_limit: u64,
        window_start: i64,
        window_used: u64,
        outstanding: u64,
        amount: u64,
        now: i64,
    ) {
        let limits = CapLimits { max_per_order, window_cap, window_secs, total_limit };
        let usage = CapUsage { window_start, window_used, outstanding };
        let result = charge(limits, usage, amount, now);
        if amount > max_per_order {
            prop_assert_eq!(result, Err(Refusal::PerOrder));
            return Ok(());
        }
        let ends = i128::from(window_start).saturating_add(i128::from(window_secs));
        let reset = i128::from(now) >= ends;
        let base = if reset { 0 } else { window_used };
        let used = u128::from(base).checked_add(u128::from(amount));
        let owed = u128::from(outstanding).checked_add(u128::from(amount));
        match result {
            Ok(next) => {
                prop_assert_eq!(Some(u128::from(next.window_used)), used);
                prop_assert_eq!(Some(u128::from(next.outstanding)), owed);
                prop_assert!(next.window_used <= window_cap);
                prop_assert!(total_limit == 0 || next.outstanding <= total_limit);
                prop_assert_eq!(next.window_start, if reset { now } else { window_start });
            }
            Err(Refusal::Overflow) => {
                let wide = u128::from(u64::MAX);
                prop_assert!(used.is_some_and(|u| u > wide) || owed.is_some_and(|o| o > wide));
            }
            Err(Refusal::Window) => prop_assert!(used.is_some_and(|u| u > u128::from(window_cap))),
            Err(Refusal::Total) => {
                prop_assert!(total_limit != 0 && owed.is_some_and(|o| o > u128::from(total_limit)));
            }
            Err(Refusal::PerOrder) => prop_assert!(false),
        }
    }

    #[test]
    fn catalog_a_give_back_never_returns_more_than_held_nor_underflows(
        outstanding: u64,
        capped: u64,
        left: u64,
        cap_created_at: i64,
        intent_created_at: i64,
    ) {
        let counted = left.min(capped);
        let counts = cap_created_at <= intent_created_at;
        match give_back_since(outstanding, capped, left, cap_created_at, intent_created_at) {
            Ok(r) => {
                prop_assert_eq!(r.counted, counted);
                prop_assert_eq!(r.capped.checked_add(r.counted), Some(capped));
                let lowered = if counts { outstanding.checked_sub(counted) } else { Some(outstanding) };
                prop_assert_eq!(Some(r.outstanding), lowered);
            }
            Err(e) => {
                prop_assert_eq!(e, Refusal::Overflow);
                prop_assert!(counts && counted > outstanding);
            }
        }
    }

    #[test]
    fn catalog_a_mandate_spend_counts_exactly_or_refuses(
        escrow in 1u64..,
        agent_fee: u64,
        spent: u64,
        per_intent: u64,
        total: u64,
    ) {
        let limits = open_limits(per_intent, total, agent_fee, i64::MAX);
        let cost = u128::from(escrow).checked_add(u128::from(agent_fee));
        let after = cost.and_then(|c| c.checked_add(u128::from(spent)));
        let used = Usage { spent, intents: 0 };
        match limits.admit(used, &swap(escrow), 1, 0) {
            Ok(next) => {
                prop_assert!(cost.is_some_and(|c| c <= u128::from(per_intent)));
                prop_assert_eq!(Some(u128::from(next.spent)), after);
                prop_assert!(next.spent <= total);
                prop_assert_eq!(next.intents, 1);
            }
            Err(Error::MandateCap) => prop_assert!(cost.is_some_and(|c| c > u128::from(per_intent))),
            Err(Error::MandateBudget) => prop_assert!(after.is_some_and(|a| a > u128::from(total))),
            Err(e) => return Err(TestCaseError::fail(format!("unexpected refusal {e:?}"))),
        }
    }

    #[test]
    fn catalog_the_ttl_check_matches_exact_arithmetic(
        now: i64,
        ahead in 1i128..=18_446_744_073_709_551_616i128,
        max_ttl in 1i64..,
    ) {
        let expires = i128::from(now).checked_add(ahead).filter(|e| *e <= i128::from(i64::MAX));
        let Some(expires_at) = expires.and_then(|e| i64::try_from(e).ok()) else {
            return Ok(());
        };
        let limits = open_limits(u64::MAX, u64::MAX, 0, max_ttl);
        let got = limits.admit(Usage::default(), &swap(1), expires_at, now);
        if ahead > i128::from(max_ttl) {
            prop_assert_eq!(got, Err(Error::MandateTtl));
        } else {
            prop_assert!(got.is_ok());
        }
    }
}
