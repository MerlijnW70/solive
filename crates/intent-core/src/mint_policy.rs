pub const INTEREST_BEARING_CONFIG: u16 = 10;
pub const METADATA_POINTER: u16 = 18;
pub const TOKEN_METADATA: u16 = 19;
pub const GROUP_POINTER: u16 = 20;
pub const TOKEN_GROUP: u16 = 21;
pub const GROUP_MEMBER_POINTER: u16 = 22;
pub const TOKEN_GROUP_MEMBER: u16 = 23;
pub const SCALED_UI_AMOUNT: u16 = 25;

pub const ALLOWED_MINT_EXTENSIONS: [u16; 8] = [
    INTEREST_BEARING_CONFIG,
    METADATA_POINTER,
    TOKEN_METADATA,
    GROUP_POINTER,
    TOKEN_GROUP,
    GROUP_MEMBER_POINTER,
    TOKEN_GROUP_MEMBER,
    SCALED_UI_AMOUNT,
];

pub fn mint_extension_allowed(code: u16) -> bool {
    ALLOWED_MINT_EXTENSIONS.contains(&code)
}

pub fn mint_extensions_allowed<I: IntoIterator<Item = u16>>(codes: I) -> bool {
    codes.into_iter().all(mint_extension_allowed)
}
