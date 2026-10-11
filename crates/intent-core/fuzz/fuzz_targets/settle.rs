#![no_main]

use intent_core::kinds::Intent;
use intent_core::{Error, PARAMS_LEN};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|input: (u8, [u8; PARAMS_LEN], u64, u64, i64)| {
    let (kind, params, amount_in, amount_out, now) = input;
    let Ok(intent) = Intent::decode(kind, &params) else {
        return;
    };
    assert_eq!(intent.kind() as u8, kind);
    assert_eq!(intent.encode(), Ok(params));
    let settled = intent.settle(amount_in, amount_out, now);
    match intent.required_out(amount_in, now) {
        Ok(required) => {
            assert!(required > 0);
            assert_eq!(settled.is_ok(), amount_out >= required);
            if let Intent::DutchAuction(p) = intent {
                assert!(required >= p.end_out && required <= p.start_out);
            }
            if let Intent::LimitOrder(p) = intent {
                let lhs = u128::from(required) * u128::from(p.make_amount);
                let rhs = u128::from(p.take_amount) * u128::from(amount_in);
                assert!(lhs >= rhs);
                assert!(lhs - rhs < u128::from(p.make_amount));
            }
        }
        Err(e) => {
            assert_eq!(settled, Err(e));
            if let Intent::AttestedResult(_) = intent {
                assert_eq!(e, Error::KindMismatch);
            } else {
                assert!(matches!(e, Error::AmountMismatch | Error::Overflow));
            }
        }
    }
});
