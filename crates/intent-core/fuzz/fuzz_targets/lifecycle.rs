#![no_main]

use intent_core::lifecycle::{transition, Action, Status};
use intent_core::Error;
use libfuzzer_sys::fuzz_target;

const ACTIONS: [Action; 6] = [
    Action::Fill,
    Action::Cancel,
    Action::Expire,
    Action::Close,
    Action::Begin,
    Action::End,
];

fuzz_target!(|input: (u8, u8, i64, i64)| {
    let (status, action, now, expires_at) = input;
    let Ok(status) = Status::try_from(status) else {
        assert!(status > 4);
        return;
    };
    assert_eq!(status as u8, input.0);
    let action = ACTIONS[usize::from(action) % ACTIONS.len()];
    let live = now < expires_at;
    let terminal = matches!(
        status,
        Status::Filled | Status::Cancelled | Status::Expired
    );
    match transition(status, action, now, expires_at) {
        Ok(Some(next)) => match action {
            Action::Fill => assert!(status == Status::Open && live && next == Status::Filled),
            Action::Begin => assert!(status == Status::Open && live && next == Status::Filling),
            Action::End => assert!(status == Status::Filling && next == Status::Filled),
            Action::Cancel => assert!(status == Status::Open && next == Status::Cancelled),
            Action::Expire => assert!(status == Status::Open && !live && next == Status::Expired),
            Action::Close => unreachable!(),
        },
        Ok(None) => assert!(action == Action::Close && terminal),
        Err(Error::IntentExpired) => {
            assert!(status == Status::Open && !live);
            assert!(matches!(action, Action::Fill | Action::Begin));
        }
        Err(Error::NotExpired) => {
            assert!(status == Status::Open && live && action == Action::Expire);
        }
        Err(e) => {
            assert_eq!(e, Error::InvalidTransition);
            let allowed = match action {
                Action::Fill | Action::Begin | Action::Cancel | Action::Expire => {
                    status == Status::Open
                }
                Action::End => status == Status::Filling,
                Action::Close => terminal,
            };
            assert!(!allowed);
        }
    }
});
