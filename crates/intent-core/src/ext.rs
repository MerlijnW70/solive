use crate::Error;

pub const EXT_MAX_LEN: usize = 512;
pub const PARTNER_TAG: u8 = 1;
pub const PARTNER_LEN: usize = 34;
pub const MAX_PARTNER_BPS: u16 = 100;
pub const CREATE_EXT_TAGS: &[u8] = &[PARTNER_TAG];
pub const FILL_EXT_TAGS: &[u8] = &[];
pub const SETTLE_EXT_TAGS: &[u8] = &[];
pub const KNOWN_FLAGS: u16 = 0;

pub fn check_flags(flags: u16) -> Result<(), Error> {
    if flags & !KNOWN_FLAGS == 0 {
        Ok(())
    } else {
        Err(Error::FlagsUnknown)
    }
}

struct Field<'a> {
    tag: u8,
    value: &'a [u8],
    tail: &'a [u8],
}

fn next(rest: &[u8]) -> Result<Option<Field<'_>>, Error> {
    let Some((&tag, after)) = rest.split_first() else {
        return Ok(None);
    };
    let (len, body) = after.split_first_chunk::<2>().ok_or(Error::ExtMalformed)?;
    let (value, tail) = body
        .split_at_checked(usize::from(u16::from_le_bytes(*len)))
        .ok_or(Error::ExtMalformed)?;
    Ok(Some(Field { tag, value, tail }))
}

pub fn validate(ext: &[u8], known: &[u8]) -> Result<(), Error> {
    if ext.len() > EXT_MAX_LEN {
        return Err(Error::ExtTooLong);
    }
    let mut rest = ext;
    let mut last = 0u8;
    while let Some(Field { tag, tail, .. }) = next(rest)? {
        if tag <= last {
            return Err(Error::ExtMalformed);
        }
        if !known.contains(&tag) {
            return Err(Error::ExtUnknown);
        }
        last = tag;
        rest = tail;
    }
    Ok(())
}

pub fn find<'a>(ext: &'a [u8], known: &[u8], wanted: u8) -> Result<Option<&'a [u8]>, Error> {
    validate(ext, known)?;
    let mut rest = ext;
    while let Some(Field { tag, value, tail }) = next(rest)? {
        if tag == wanted {
            return Ok(Some(value));
        }
        rest = tail;
    }
    Ok(None)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Partner {
    pub key: [u8; 32],
    pub bps: u16,
}

pub fn partner(ext: &[u8]) -> Result<Option<Partner>, Error> {
    let Some(value) = find(ext, CREATE_EXT_TAGS, PARTNER_TAG)? else {
        return Ok(None);
    };
    let (key, rest) = value.split_first_chunk::<32>().ok_or(Error::ExtMalformed)?;
    let (key, bps) = (
        *key,
        u16::from_le_bytes(<[u8; 2]>::try_from(rest).map_err(|_| Error::ExtMalformed)?),
    );
    if key == [0; 32] || bps == 0 {
        return Err(Error::ExtMalformed);
    }
    if bps > MAX_PARTNER_BPS {
        return Err(Error::PartnerFeeTooHigh);
    }
    Ok(Some(Partner { key, bps }))
}
