use intent_core::profile::{
    document, encryption_key, skill, skills, url, KEY_LEN, MAX_SKILLS, MAX_URL_LEN, SKILL_LEN,
};
use intent_core::Error;
use proptest::prelude::*;

#[test]
fn a_skill_is_a_short_lowercase_tag() -> Result<(), Error> {
    let packed = skill(b"rust")?;
    assert_eq!(packed.get(..4), Some(&b"rust"[..]));
    assert!(packed
        .get(4..)
        .is_some_and(|rest| rest.iter().all(|b| *b == 0)));
    assert!(skill(b"code-review").is_ok());
    assert!(skill(&[b'a'; SKILL_LEN]).is_ok());
    for bad in [
        &b""[..],
        b"Rust",
        b"-rust",
        b"rust-",
        b"ru st",
        b"r_ust",
        &[b'a'; SKILL_LEN + 1],
    ] {
        assert_eq!(skill(bad), Err(Error::ProfileInvalid), "{bad:?}");
    }
    Ok(())
}

#[test]
fn a_profile_names_one_to_eight_distinct_skills() -> Result<(), Error> {
    let packed = skills(&[b"rust", b"writing"])?;
    assert_eq!(
        packed.get(1).and_then(|s| s.get(..7)),
        Some(&b"writing"[..])
    );
    assert!(packed
        .get(2..)
        .is_some_and(|rest| rest.iter().all(|s| *s == [0; SKILL_LEN])));
    let eight: Vec<Vec<u8>> = (0..MAX_SKILLS)
        .map(|i| format!("s{i}").into_bytes())
        .collect();
    let refs: Vec<&[u8]> = eight.iter().map(Vec::as_slice).collect();
    assert!(skills(&refs).is_ok());
    let nine: Vec<Vec<u8>> = (0..=MAX_SKILLS)
        .map(|i| format!("s{i}").into_bytes())
        .collect();
    let refs: Vec<&[u8]> = nine.iter().map(Vec::as_slice).collect();
    assert_eq!(skills(&refs), Err(Error::ProfileInvalid));
    assert_eq!(skills(&[]), Err(Error::ProfileInvalid));
    assert_eq!(skills(&[b"rust", b"rust"]), Err(Error::ProfileInvalid));
    Ok(())
}

#[test]
fn urls_are_https_printable_and_bounded() -> Result<(), Error> {
    let packed = url(b"https://agent.example/api", false)?;
    assert_eq!(packed.get(..25), Some(&b"https://agent.example/api"[..]));
    assert_eq!(url(b"", true)?, [0; MAX_URL_LEN]);
    let long = [b"https://".as_slice(), &[b'a'; MAX_URL_LEN - 8]].concat();
    assert!(url(&long, false).is_ok());
    let too_long = [long.as_slice(), b"a"].concat();
    for bad in [
        &b""[..],
        b"https://",
        b"http://agent.example",
        b"https://agent example",
        b"https://agent.example/\\x",
        too_long.as_slice(),
    ] {
        assert_eq!(url(bad, false), Err(Error::ProfileInvalid), "{bad:?}");
    }
    Ok(())
}

#[test]
fn a_document_url_comes_with_its_hash_and_no_hash_without_a_url() -> Result<(), Error> {
    assert!(document(b"https://agent.example/profile.json", &[7; 32]).is_ok());
    assert_eq!(document(b"", &[0; 32])?, [0; MAX_URL_LEN]);
    assert_eq!(
        document(b"https://agent.example/p.json", &[0; 32]),
        Err(Error::ProfileInvalid)
    );
    assert_eq!(document(b"", &[7; 32]), Err(Error::ProfileInvalid));
    Ok(())
}

fn key_of(low: u8, middle: u8, top: u8) -> [u8; KEY_LEN] {
    let mut key = [middle; KEY_LEN];
    key[0] = low;
    key[KEY_LEN - 1] = top;
    key
}

#[test]
fn an_encryption_key_is_zero_or_a_canonical_key_of_large_order() -> Result<(), Error> {
    assert_eq!(encryption_key(&[0; KEY_LEN])?, [0; KEY_LEN]);
    let fine = key_of(9, 3, 0x11);
    assert_eq!(encryption_key(&fine)?, fine);
    assert_eq!(
        encryption_key(&key_of(0xeb, 0xff, 0x7f))?,
        key_of(0xeb, 0xff, 0x7f)
    );
    let mut order_eight = [0; KEY_LEN];
    order_eight[..8].copy_from_slice(&[0xe0, 0xeb, 0x7a, 0x7c, 0x3b, 0x41, 0xb8, 0xae]);
    order_eight[8..16].copy_from_slice(&[0x16, 0x56, 0xe3, 0xfa, 0xf1, 0x9f, 0xc4, 0x6a]);
    order_eight[16..24].copy_from_slice(&[0xda, 0x09, 0x8d, 0xeb, 0x9c, 0x32, 0xb1, 0xfd]);
    order_eight[24..].copy_from_slice(&[0x86, 0x62, 0x05, 0x16, 0x5f, 0x49, 0xb8, 0x00]);
    for bad in [
        key_of(1, 0, 0),
        key_of(0xec, 0xff, 0x7f),
        key_of(0xed, 0xff, 0x7f),
        key_of(0xee, 0xff, 0x7f),
        key_of(9, 3, 0x91),
        order_eight,
    ] {
        assert_eq!(encryption_key(&bad), Err(Error::ProfileInvalid), "{bad:?}");
    }
    Ok(())
}

proptest! {
    #[test]
    fn a_skill_is_accepted_exactly_when_it_is_shaped(tag in proptest::collection::vec(any::<u8>(), 0..20)) {
        let shaped = !tag.is_empty()
            && tag.len() <= SKILL_LEN
            && tag.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
            && tag.first() != Some(&b'-')
            && tag.last() != Some(&b'-');
        prop_assert_eq!(skill(&tag).is_ok(), shaped);
    }
}
