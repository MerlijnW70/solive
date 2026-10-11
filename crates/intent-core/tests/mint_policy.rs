use intent_core::mint_policy::{
    mint_extension_allowed, mint_extensions_allowed, ALLOWED_MINT_EXTENSIONS, GROUP_MEMBER_POINTER,
    GROUP_POINTER, INTEREST_BEARING_CONFIG, METADATA_POINTER, SCALED_UI_AMOUNT, TOKEN_GROUP,
    TOKEN_GROUP_MEMBER, TOKEN_METADATA,
};

#[test]
fn allowed_codes_are_pinned() {
    assert_eq!(INTEREST_BEARING_CONFIG, 10);
    assert_eq!(METADATA_POINTER, 18);
    assert_eq!(TOKEN_METADATA, 19);
    assert_eq!(GROUP_POINTER, 20);
    assert_eq!(TOKEN_GROUP, 21);
    assert_eq!(GROUP_MEMBER_POINTER, 22);
    assert_eq!(TOKEN_GROUP_MEMBER, 23);
    assert_eq!(SCALED_UI_AMOUNT, 25);
    assert_eq!(ALLOWED_MINT_EXTENSIONS, [10, 18, 19, 20, 21, 22, 23, 25]);
}

#[test]
fn every_code_outside_allowlist_is_rejected() {
    for code in 0..=u16::MAX {
        assert_eq!(
            mint_extension_allowed(code),
            ALLOWED_MINT_EXTENSIONS.contains(&code),
            "{code}"
        );
    }
}

#[test]
fn transfer_altering_and_mint_closing_extensions_are_rejected() {
    for code in [0u16, 1, 3, 4, 6, 9, 12, 14, 16, 24, 26, 27, u16::MAX] {
        assert!(!mint_extension_allowed(code), "{code}");
    }
}

#[test]
fn extension_sets_pass_only_when_every_member_is_allowed() {
    assert!(mint_extensions_allowed([]));
    assert!(mint_extensions_allowed([METADATA_POINTER, TOKEN_METADATA]));
    assert!(mint_extensions_allowed(ALLOWED_MINT_EXTENSIONS));
    assert!(!mint_extensions_allowed([METADATA_POINTER, 14]));
    assert!(!mint_extensions_allowed([12]));
    assert!(!mint_extensions_allowed([14, METADATA_POINTER]));
}
