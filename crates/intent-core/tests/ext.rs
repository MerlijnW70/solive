use intent_core::ext::{
    check_flags, find, partner, validate, Partner, CREATE_EXT_TAGS, EXT_MAX_LEN, FILL_EXT_TAGS,
    KNOWN_FLAGS, MAX_PARTNER_BPS, PARTNER_LEN, PARTNER_TAG, SETTLE_EXT_TAGS,
};
use intent_core::Error;

fn entry(tag: u8, value: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    out.extend_from_slice(&u16::try_from(value.len()).unwrap_or(u16::MAX).to_le_bytes());
    out.extend_from_slice(value);
    out
}

#[test]
fn v1_accepts_only_an_empty_extension_and_no_flags() {
    assert_eq!(CREATE_EXT_TAGS, &[PARTNER_TAG]);
    assert_eq!((PARTNER_TAG, PARTNER_LEN, MAX_PARTNER_BPS), (1, 34, 100));
    assert!(FILL_EXT_TAGS.is_empty());
    assert!(SETTLE_EXT_TAGS.is_empty());
    assert_eq!(KNOWN_FLAGS, 0);
    assert_eq!(validate(&[], CREATE_EXT_TAGS), Ok(()));
    assert_eq!(
        validate(&entry(2, b"x"), CREATE_EXT_TAGS),
        Err(Error::ExtUnknown)
    );
    assert_eq!(
        validate(&entry(1, b"x"), FILL_EXT_TAGS),
        Err(Error::ExtUnknown)
    );
    assert_eq!(check_flags(0), Ok(()));
    for flags in [1u16, 0x8000, u16::MAX] {
        assert_eq!(check_flags(flags), Err(Error::FlagsUnknown), "{flags}");
    }
}

#[test]
fn known_tags_validate_in_strictly_increasing_order() {
    let known = [3u8, 7, 200];
    let good = [entry(3, b"a"), entry(7, b""), entry(200, &[9; 40])].concat();
    assert_eq!(validate(&good, &known), Ok(()));
    let repeated = [entry(3, b"a"), entry(3, b"b")].concat();
    assert_eq!(validate(&repeated, &known), Err(Error::ExtMalformed));
    let descending = [entry(7, b"a"), entry(3, b"b")].concat();
    assert_eq!(validate(&descending, &known), Err(Error::ExtMalformed));
    assert_eq!(validate(&entry(0, b"a"), &[0]), Err(Error::ExtMalformed));
    assert_eq!(validate(&entry(4, b"a"), &known), Err(Error::ExtUnknown));
}

#[test]
fn truncated_or_oversized_extensions_are_refused() {
    let known = [5u8];
    let whole = entry(5, b"abcd");
    for cut in 1..whole.len() {
        assert_eq!(
            validate(whole.get(..cut).unwrap_or(&[]), &known),
            Err(Error::ExtMalformed),
            "{cut}"
        );
    }
    let fits = entry(5, &vec![0; EXT_MAX_LEN - 3]);
    assert_eq!(fits.len(), EXT_MAX_LEN);
    assert_eq!(validate(&fits, &known), Ok(()));
    let over = entry(5, &vec![0; EXT_MAX_LEN - 2]);
    assert_eq!(validate(&over, &known), Err(Error::ExtTooLong));
    assert_eq!(EXT_MAX_LEN, 512);
}

#[test]
fn find_returns_the_value_of_a_present_tag_only() {
    let known = [2u8, 9, 30];
    let ext = [entry(2, b"two"), entry(9, b""), entry(30, b"thirty")].concat();
    assert_eq!(find(&ext, &known, 2), Ok(Some(&b"two"[..])));
    assert_eq!(find(&ext, &known, 9), Ok(Some(&b""[..])));
    assert_eq!(find(&ext, &known, 30), Ok(Some(&b"thirty"[..])));
    assert_eq!(find(&ext, &known, 3), Ok(None));
    assert_eq!(find(&[], &known, 3), Ok(None));
    assert_eq!(find(&[2, 5, 0, 1], &known, 2), Err(Error::ExtMalformed));
    assert_eq!(find(&[2, 1], &known, 9), Err(Error::ExtMalformed));
    assert_eq!(find(&ext, &[2, 9], 2), Err(Error::ExtUnknown));
    let repeated = [entry(2, b"a"), entry(2, b"b")].concat();
    assert_eq!(find(&repeated, &known, 2), Err(Error::ExtMalformed));
    let long = entry(2, &vec![0; EXT_MAX_LEN - 2]);
    assert_eq!(find(&long, &known, 2), Err(Error::ExtTooLong));
}

fn partner_entry(key: [u8; 32], bps: u16) -> Vec<u8> {
    entry(PARTNER_TAG, &[&key[..], &bps.to_le_bytes()[..]].concat())
}

#[test]
fn a_partner_names_a_nonzero_key_and_a_bounded_share() {
    assert_eq!(partner(&[]), Ok(None));
    assert_eq!(
        partner(&partner_entry([7; 32], 1)),
        Ok(Some(Partner {
            key: [7; 32],
            bps: 1
        }))
    );
    assert_eq!(
        partner(&partner_entry([7; 32], MAX_PARTNER_BPS)),
        Ok(Some(Partner {
            key: [7; 32],
            bps: MAX_PARTNER_BPS
        }))
    );
    assert_eq!(
        partner(&partner_entry([7; 32], MAX_PARTNER_BPS + 1)),
        Err(Error::PartnerFeeTooHigh)
    );
    assert_eq!(
        partner(&partner_entry([7; 32], 0)),
        Err(Error::ExtMalformed)
    );
    assert_eq!(
        partner(&partner_entry([0; 32], 5)),
        Err(Error::ExtMalformed)
    );
    let mut key = [0; 32];
    key[31] = 1;
    assert_eq!(
        partner(&partner_entry(key, 5)),
        Ok(Some(Partner { key, bps: 5 }))
    );
    for len in [0usize, 31, 33, 35, 64] {
        assert_eq!(
            partner(&entry(PARTNER_TAG, &vec![9; len])),
            Err(Error::ExtMalformed),
            "{len}"
        );
    }
    assert_eq!(partner(&entry(2, &[9; 34])), Err(Error::ExtUnknown));
    assert_eq!(partner(&[1, 34]), Err(Error::ExtMalformed));
}
