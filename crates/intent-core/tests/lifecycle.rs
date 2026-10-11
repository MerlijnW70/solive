use intent_core::lifecycle::{transition, Action, Status};
use intent_core::Error;

const EXPIRY: i64 = 1_000;
const BEFORE: i64 = 999;

const STATUSES: [Status; 5] = [
    Status::Open,
    Status::Filled,
    Status::Cancelled,
    Status::Expired,
    Status::Filling,
];
const ACTIONS: [Action; 6] = [
    Action::Fill,
    Action::Cancel,
    Action::Expire,
    Action::Close,
    Action::Begin,
    Action::End,
];

fn expected(status: Status, action: Action, now: i64) -> Result<Option<Status>, Error> {
    match (status, action, now >= EXPIRY) {
        (Status::Open, Action::Fill, false) => Ok(Some(Status::Filled)),
        (Status::Open, Action::Fill, true) => Err(Error::IntentExpired),
        (Status::Open, Action::Begin, false) => Ok(Some(Status::Filling)),
        (Status::Open, Action::Begin, true) => Err(Error::IntentExpired),
        (Status::Filling, Action::End, _) => Ok(Some(Status::Filled)),
        (Status::Open, Action::Cancel, _) => Ok(Some(Status::Cancelled)),
        (Status::Open, Action::Expire, true) => Ok(Some(Status::Expired)),
        (Status::Open, Action::Expire, false) => Err(Error::NotExpired),
        (Status::Open | Status::Filling, Action::Close, _) => Err(Error::InvalidTransition),
        (_, Action::Close, _) => Ok(None),
        _ => Err(Error::InvalidTransition),
    }
}

#[test]
fn transition_table_is_exhaustive_at_expiry_boundary() {
    for status in STATUSES {
        for action in ACTIONS {
            for now in [i64::MIN, BEFORE, EXPIRY, i64::MAX] {
                assert_eq!(
                    transition(status, action, now, EXPIRY),
                    expected(status, action, now),
                    "{status:?} {action:?} {now}"
                );
            }
        }
    }
}

#[test]
fn open_intent_fill_and_expire_split_exactly_at_expiry() {
    assert_eq!(
        transition(Status::Open, Action::Fill, BEFORE, EXPIRY),
        Ok(Some(Status::Filled))
    );
    assert_eq!(
        transition(Status::Open, Action::Fill, EXPIRY, EXPIRY),
        Err(Error::IntentExpired)
    );
    assert_eq!(
        transition(Status::Open, Action::Expire, BEFORE, EXPIRY),
        Err(Error::NotExpired)
    );
    assert_eq!(
        transition(Status::Open, Action::Expire, EXPIRY, EXPIRY),
        Ok(Some(Status::Expired))
    );
}

#[test]
fn status_round_trips_through_u8() {
    for status in STATUSES {
        assert_eq!(Status::try_from(status as u8), Ok(status));
    }
    assert_eq!(Status::try_from(0), Ok(Status::Open));
    assert_eq!(Status::try_from(1), Ok(Status::Filled));
    assert_eq!(Status::try_from(2), Ok(Status::Cancelled));
    assert_eq!(Status::try_from(3), Ok(Status::Expired));
    assert_eq!(Status::try_from(4), Ok(Status::Filling));
    assert_eq!(Status::try_from(5), Err(Error::UnknownStatus));
    assert_eq!(Status::try_from(u8::MAX), Err(Error::UnknownStatus));
}

#[test]
fn flash_fill_opens_only_before_expiry_and_closes_only_from_filling() {
    assert_eq!(
        transition(Status::Open, Action::Begin, BEFORE, EXPIRY),
        Ok(Some(Status::Filling))
    );
    assert_eq!(
        transition(Status::Open, Action::Begin, EXPIRY, EXPIRY),
        Err(Error::IntentExpired)
    );
    assert_eq!(
        transition(Status::Filling, Action::End, i64::MAX, EXPIRY),
        Ok(Some(Status::Filled))
    );
    for action in [
        Action::Fill,
        Action::Cancel,
        Action::Expire,
        Action::Close,
        Action::Begin,
    ] {
        assert_eq!(
            transition(Status::Filling, action, BEFORE, EXPIRY),
            Err(Error::InvalidTransition),
            "{action:?}"
        );
    }
    assert_eq!(
        transition(Status::Open, Action::End, BEFORE, EXPIRY),
        Err(Error::InvalidTransition)
    );
}
