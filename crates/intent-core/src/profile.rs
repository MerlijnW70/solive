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
