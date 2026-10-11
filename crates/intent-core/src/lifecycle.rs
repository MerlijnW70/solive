use crate::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Status {
    Open = 0,
    Filled = 1,
    Cancelled = 2,
    Expired = 3,
    Filling = 4,
}

impl TryFrom<u8> for Status {
    type Error = Error;

    fn try_from(v: u8) -> Result<Self, Error> {
        match v {
            0 => Ok(Self::Open),
            1 => Ok(Self::Filled),
            2 => Ok(Self::Cancelled),
            3 => Ok(Self::Expired),
            4 => Ok(Self::Filling),
            _ => Err(Error::UnknownStatus),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Fill,
    Cancel,
    Expire,
    Close,
    Begin,
    End,
}

pub fn transition(
    status: Status,
    action: Action,
    now: i64,
    expires_at: i64,
) -> Result<Option<Status>, Error> {
    match (status, action) {
        (Status::Open, Action::Fill) if now < expires_at => Ok(Some(Status::Filled)),
        (Status::Open, Action::Fill) => Err(Error::IntentExpired),
        (Status::Open, Action::Begin) if now < expires_at => Ok(Some(Status::Filling)),
        (Status::Open, Action::Begin) => Err(Error::IntentExpired),
        (Status::Filling, Action::End) => Ok(Some(Status::Filled)),
        (Status::Open, Action::Cancel) => Ok(Some(Status::Cancelled)),
        (Status::Open, Action::Expire) if now >= expires_at => Ok(Some(Status::Expired)),
        (Status::Open, Action::Expire) => Err(Error::NotExpired),
        (Status::Filled | Status::Cancelled | Status::Expired, Action::Close) => Ok(None),
        _ => Err(Error::InvalidTransition),
    }
}
