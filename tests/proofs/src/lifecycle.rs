use intent_core::lifecycle::{transition, Action, Status};

fn status() -> Status {
    match kani::any::<u8>() % 5 {
        0 => Status::Open,
        1 => Status::Filled,
        2 => Status::Cancelled,
        3 => Status::Expired,
        _ => Status::Filling,
    }
}

fn action() -> Action {
    match kani::any::<u8>() % 6 {
        0 => Action::Fill,
        1 => Action::Cancel,
        2 => Action::Expire,
        3 => Action::Close,
        4 => Action::Begin,
        _ => Action::End,
    }
}

#[kani::proof]
fn terminal_intents_can_only_be_closed_and_nothing_reopens() {
    let from = status();
    let act = action();
    let now: i64 = kani::any();
    let expires_at: i64 = kani::any();
    let terminal = matches!(from, Status::Filled | Status::Cancelled | Status::Expired);
    match transition(from, act, now, expires_at) {
        Ok(None) => assert!(terminal && act == Action::Close),
        Ok(Some(to)) => {
            assert_ne!(to, Status::Open);
            assert!(!terminal);
            assert_eq!(to == Status::Filling, act == Action::Begin);
            if from == Status::Filling {
                assert!(act == Action::End && to == Status::Filled);
            }
            if matches!(act, Action::Fill | Action::Begin) {
                assert!(now < expires_at);
            }
            if act == Action::Expire {
                assert!(now >= expires_at);
            }
        }
        Err(_) => assert!(!(terminal && act == Action::Close)),
    }
}

#[kani::proof]
fn statuses_round_trip_through_their_byte() {
    let b: u8 = kani::any();
    match Status::try_from(b) {
        Ok(s) => assert_eq!(s as u8, b),
        Err(_) => assert!(b > 4),
    }
}
