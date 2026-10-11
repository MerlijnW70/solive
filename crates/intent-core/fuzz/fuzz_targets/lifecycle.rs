#![no_main]

use intent_core::lifecycle::{transition, Action, Status};
use intent_core::Error;
use libfuzzer_sys::fuzz_target;

const ACTIONS: [Action; 4] = [Action::Fill, Action::Cancel, Action::Expire, Action::Close];

fuzz_target!(|input: (u8, u8, i64, i64)| {
    let (status, action, now, expires_at) = input;
    let Ok(status) = Status::try_from(status) else {
        assert!(status > 3);
        return;
    };
    assert_eq!(status as u8, input.0);
    let action = ACTIONS[usize::from(action % 4)];
    match transition(status, action, now, expires_at) {
        Ok(Some(next)) => {
            assert_eq!(status, Status::Open);
            assert_ne!(next, Status::Open);
            match next {
                Status::Filled => assert!(now < expires_at),
                Status::Expired => assert!(now >= expires_at),
                _ => {}
            }
        }
        Ok(None) => {
            assert_eq!(action, Action::Close);
            assert_ne!(status, Status::Open);
        }
        Err(Error::IntentExpired) => assert!(now >= expires_at),
        Err(Error::NotExpired) => assert!(now < expires_at),
        Err(e) => assert_eq!(e, Error::InvalidTransition),
    }
});
