#![no_main]

use intent_core::kinds::Intent;
use intent_core::mandate::{worst_out, Limits, Usage, MANDATE_KINDS};
use intent_core::{Error, PARAMS_LEN};
use libfuzzer_sys::fuzz_target;

type Limit = (u8, u64, u64, u32, i64, i64, u64, u64, u64);

fuzz_target!(|input: (Limit, i64, Vec<(u8, [u8; PARAMS_LEN], i64, i64)>)| {
    let ((kinds, per_intent, total, max_intents, max_ttl, valid_until, floor_out, floor_in, agent_fee), granted, asks) =
        input;
    let limits = Limits {
        kinds,
        per_intent,
        total,
        max_intents,
        max_ttl,
        valid_until,
        floor_out,
        floor_in,
        agent_fee,
    };
    let Ok(limits) = limits.validate(granted) else {
        return;
    };
    assert!(u64::from(limits.kinds) & !MANDATE_KINDS == 0);
    let mut usage = Usage::default();
    for (kind, params, expires_at, now) in asks {
        let Ok(intent) = Intent::decode(kind, &params) else {
            continue;
        };
        match limits.admit(usage, &intent, expires_at, now) {
            Ok(next) => {
                assert!(now < limits.valid_until);
                assert!(u64::from(limits.kinds) & intent.kind().bit() != 0);
                assert!(expires_at.saturating_sub(now) <= limits.max_ttl);
                let cost = intent.escrow_amount() + limits.agent_fee;
                assert!(cost <= limits.per_intent);
                assert_eq!(next.spent, usage.spent + cost);
                assert!(next.spent <= limits.total);
                assert_eq!(next.intents, usage.intents + 1);
                assert!(next.intents <= limits.max_intents);
                let worst = worst_out(&intent).expect("admitted kinds have a worst output");
                assert!(
                    u128::from(worst) * u128::from(limits.floor_in)
                        >= u128::from(cost) * u128::from(limits.floor_out)
                );
                usage = next;
            }
            Err(e) => {
                if now >= limits.valid_until {
                    assert_eq!(e, Error::MandateExpired);
                }
                if let Intent::AttestedResult(_) = intent {
                    assert!(matches!(e, Error::MandateExpired | Error::MandateKind));
                }
            }
        }
    }
});
