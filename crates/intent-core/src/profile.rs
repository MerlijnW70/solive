use crate::Error;

pub const MAX_SKILLS: usize = 8;
pub const SKILL_LEN: usize = 16;
pub const MAX_URL_LEN: usize = 128;
const HTTPS: &[u8] = b"https://";

pub fn skill(tag: &[u8]) -> Result<[u8; SKILL_LEN], Error> {
    let shaped = !tag.is_empty()
        && tag.len() <= SKILL_LEN
        && tag
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        && tag.first() != Some(&b'-')
        && tag.last() != Some(&b'-');
    if !shaped {
        return Err(Error::ProfileInvalid);
    }
    let mut out = [0; SKILL_LEN];
    for (slot, byte) in out.iter_mut().zip(tag) {
        *slot = *byte;
    }
    Ok(out)
}

pub fn skills(tags: &[&[u8]]) -> Result<[[u8; SKILL_LEN]; MAX_SKILLS], Error> {
    if tags.is_empty() || tags.len() > MAX_SKILLS {
        return Err(Error::ProfileInvalid);
    }
    let mut out = [[0; SKILL_LEN]; MAX_SKILLS];
    for (i, tag) in tags.iter().enumerate() {
        let packed = skill(tag)?;
        if out.iter().take(i).any(|seen| *seen == packed) {
            return Err(Error::ProfileInvalid);
        }
        if let Some(slot) = out.get_mut(i) {
            *slot = packed;
        }
    }
    Ok(out)
}

pub fn url(text: &[u8], optional: bool) -> Result<[u8; MAX_URL_LEN], Error> {
    let mut out = [0; MAX_URL_LEN];
    if text.is_empty() && optional {
        return Ok(out);
    }
    let shaped = text.len() > HTTPS.len()
        && text.len() <= MAX_URL_LEN
        && text.starts_with(HTTPS)
        && text
            .iter()
            .all(|b| (0x21..=0x7e).contains(b) && *b != b'\\');
    if !shaped {
        return Err(Error::ProfileInvalid);
    }
    for (slot, byte) in out.iter_mut().zip(text) {
        *slot = *byte;
    }
    Ok(out)
}

pub fn document(url_text: &[u8], hash: &[u8; 32]) -> Result<[u8; MAX_URL_LEN], Error> {
    let packed = url(url_text, true)?;
    if url_text.is_empty() != (*hash == [0; 32]) {
        return Err(Error::ProfileInvalid);
    }
    Ok(packed)
}

pub const KEY_LEN: usize = 32;
const TOP: usize = KEY_LEN - 1;
const SIGN_BIT: u8 = 0x80;
const LOW_ORDER: [[u8; KEY_LEN]; 4] = [
    [
        1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0,
    ],
    [
        0xe0, 0xeb, 0x7a, 0x7c, 0x3b, 0x41, 0xb8, 0xae, 0x16, 0x56, 0xe3, 0xfa, 0xf1, 0x9f, 0xc4,
        0x6a, 0xda, 0x09, 0x8d, 0xeb, 0x9c, 0x32, 0xb1, 0xfd, 0x86, 0x62, 0x05, 0x16, 0x5f, 0x49,
        0xb8, 0x00,
    ],
    [
        0x5f, 0x9c, 0x95, 0xbc, 0xa3, 0x50, 0x8c, 0x24, 0xb1, 0xd0, 0xb1, 0x55, 0x9c, 0x83, 0xef,
        0x5b, 0x04, 0x44, 0x5c, 0xc4, 0x58, 0x1c, 0x8e, 0x86, 0xd8, 0x22, 0x4e, 0xdd, 0xd0, 0x9f,
        0x11, 0x57,
    ],
    [
        0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0x7f,
    ],
];
const FIELD_LOW: u8 = 0xed;

fn canonical(key: &[u8; KEY_LEN]) -> bool {
    let top = key.get(TOP).copied().unwrap_or(SIGN_BIT);
    let middle = key
        .get(1..TOP)
        .is_some_and(|m| m.iter().all(|b| *b == 0xff));
    let low = key.first().copied().unwrap_or(0);
    top & SIGN_BIT == 0 && !(top == 0x7f && middle && low >= FIELD_LOW)
}

pub fn encryption_key(key: &[u8; KEY_LEN]) -> Result<[u8; KEY_LEN], Error> {
    if *key == [0; KEY_LEN] {
        return Ok(*key);
    }
    if !canonical(key) || LOW_ORDER.contains(key) {
        return Err(Error::ProfileInvalid);
    }
    Ok(*key)
}
