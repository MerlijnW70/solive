use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use core::mem::offset_of;

use crate::state::{
    Announcement, ClaimBoard, ClaimList, Committee, Config, DeliveryBook, Intent, Mandate, MintCap,
    Profile, Refutation, Standby, UserState, ANNOUNCEMENT_VERSION, CLAIMS_VERSION,
    CLAIM_LIST_VERSION, COMMITTEE_VERSION, CONFIG_VERSION, DELIVERY_BOOK_VERSION, INTENT_VERSION,
    MANDATE_VERSION, MINT_CAP_VERSION, OLDEST_CLAIMS_VERSION, OLDEST_INTENT_VERSION,
    OLDEST_MINT_CAP_VERSION, PROFILE_VERSION, REFUTATION_VERSION, STANDBY_VERSION, USER_VERSION,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Layout {
    pub discriminator: &'static [u8],
    pub space: usize,
    pub version_at: usize,
    pub version: u8,
    pub oldest: u8,
    pub payer_at: Option<usize>,
}

pub const LAYOUTS: [Layout; 13] = [
    Layout {
        discriminator: Config::DISCRIMINATOR,
        space: Config::SPACE,
        version_at: offset_of!(Config, version),
        version: CONFIG_VERSION,
        oldest: CONFIG_VERSION,
        payer_at: Some(offset_of!(Config, admin)),
    },
    Layout {
        discriminator: UserState::DISCRIMINATOR,
        space: UserState::SPACE,
        version_at: offset_of!(UserState, version),
        version: USER_VERSION,
        oldest: USER_VERSION,
        payer_at: Some(offset_of!(UserState, owner)),
    },
    Layout {
        discriminator: Intent::DISCRIMINATOR,
        space: Intent::SPACE,
        version_at: offset_of!(Intent, version),
        version: INTENT_VERSION,
        oldest: OLDEST_INTENT_VERSION,
        payer_at: Some(offset_of!(Intent, rent_payer)),
    },
    Layout {
        discriminator: Mandate::DISCRIMINATOR,
        space: Mandate::SPACE,
        version_at: offset_of!(Mandate, version),
        version: MANDATE_VERSION,
        oldest: MANDATE_VERSION,
        payer_at: Some(offset_of!(Mandate, owner)),
    },
    Layout {
        discriminator: MintCap::DISCRIMINATOR,
        space: MintCap::SPACE,
        version_at: offset_of!(MintCap, version),
        version: MINT_CAP_VERSION,
        oldest: OLDEST_MINT_CAP_VERSION,
        payer_at: None,
    },
    Layout {
        discriminator: Committee::DISCRIMINATOR,
        space: Committee::SPACE,
        version_at: offset_of!(Committee, version),
        version: COMMITTEE_VERSION,
        oldest: COMMITTEE_VERSION,
        payer_at: None,
    },
    Layout {
        discriminator: ClaimBoard::DISCRIMINATOR,
        space: ClaimBoard::SPACE,
        version_at: offset_of!(ClaimBoard, version),
        version: CLAIMS_VERSION,
        oldest: OLDEST_CLAIMS_VERSION,
        payer_at: Some(offset_of!(ClaimBoard, owner)),
    },
    Layout {
        discriminator: Standby::DISCRIMINATOR,
        space: Standby::SPACE,
        version_at: offset_of!(Standby, version),
        version: STANDBY_VERSION,
        oldest: STANDBY_VERSION,
        payer_at: Some(offset_of!(Standby, worker)),
    },
    Layout {
        discriminator: Profile::DISCRIMINATOR,
        space: Profile::SPACE,
        version_at: offset_of!(Profile, version),
        version: PROFILE_VERSION,
        oldest: PROFILE_VERSION,
        payer_at: Some(offset_of!(Profile, wallet)),
    },
    Layout {
        discriminator: ClaimList::DISCRIMINATOR,
        space: ClaimList::SPACE,
        version_at: offset_of!(ClaimList, version),
        version: CLAIM_LIST_VERSION,
        oldest: CLAIM_LIST_VERSION,
        payer_at: Some(offset_of!(ClaimList, owner)),
    },
    Layout {
        discriminator: DeliveryBook::DISCRIMINATOR,
        space: DeliveryBook::SPACE,
        version_at: offset_of!(DeliveryBook, version),
        version: DELIVERY_BOOK_VERSION,
        oldest: DELIVERY_BOOK_VERSION,
        payer_at: Some(offset_of!(DeliveryBook, payer)),
    },
    Layout {
        discriminator: Announcement::DISCRIMINATOR,
        space: Announcement::SPACE,
        version_at: offset_of!(Announcement, version),
        version: ANNOUNCEMENT_VERSION,
        oldest: ANNOUNCEMENT_VERSION,
        payer_at: Some(offset_of!(Announcement, payer)),
    },
    Layout {
        discriminator: Refutation::DISCRIMINATOR,
        space: Refutation::SPACE,
        version_at: offset_of!(Refutation, version),
        version: REFUTATION_VERSION,
        oldest: REFUTATION_VERSION,
        payer_at: Some(offset_of!(Refutation, refuter)),
    },
];

pub fn layout_of(data: &[u8]) -> Option<&'static Layout> {
    LAYOUTS
        .iter()
        .find(|layout| data.get(..layout.discriminator.len()) == Some(layout.discriminator))
}

fn body_of(data: &[u8]) -> Option<(&'static Layout, &[u8])> {
    let layout = layout_of(data)?;
    Some((layout, data.get(layout.discriminator.len()..)?))
}

pub fn stored_version(data: &[u8]) -> Option<(&'static Layout, u8)> {
    let (layout, body) = body_of(data)?;
    Some((layout, *body.get(layout.version_at)?))
}

pub fn is_current(data: &[u8]) -> bool {
    matches!(
        stored_version(data),
        Some((layout, version)) if data.len() == layout.space && version == layout.version
    )
}

pub fn recorded_payer(data: &[u8]) -> Option<Pubkey> {
    let (layout, body) = body_of(data)?;
    let at = layout.payer_at?;
    let bytes: [u8; 32] = body.get(at..at.checked_add(32)?)?.try_into().ok()?;
    let payer = Pubkey::new_from_array(bytes);
    (payer != Pubkey::default()).then_some(payer)
}

pub fn readable(data: &[u8]) -> bool {
    matches!(
        stored_version(data),
        Some((layout, version)) if data.len() == layout.space && (layout.oldest..=layout.version).contains(&version)
    )
}

pub const LEGACY_BOARD_SPACE: usize = 168;

pub fn legacy_board(data: &[u8]) -> bool {
    data.len() == LEGACY_BOARD_SPACE
        && data.get(..ClaimBoard::DISCRIMINATOR.len()) == Some(ClaimBoard::DISCRIMINATOR)
        && board_version(data) == Some(OLDEST_CLAIMS_VERSION)
}

fn board_version(data: &[u8]) -> Option<u8> {
    let at = ClaimBoard::DISCRIMINATOR
        .len()
        .checked_add(offset_of!(ClaimBoard, version))?;
    data.get(at).copied()
}

pub fn is_intent(data: &[u8]) -> bool {
    data.get(..Intent::DISCRIMINATOR.len()) == Some(Intent::DISCRIMINATOR)
}

pub fn migrates_in_place(data: &[u8]) -> bool {
    [Config::DISCRIMINATOR, UserState::DISCRIMINATOR]
        .iter()
        .any(|disc| data.get(..disc.len()) == Some(*disc))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BoardTerms {
    pub intent: Pubkey,
    pub owner: Pubkey,
    pub worker: Pubkey,
    pub until: i64,
    pub held: u64,
}

fn key_at(body: &[u8], at: usize) -> Option<Pubkey> {
    let bytes: [u8; 32] = body.get(at..at.checked_add(32)?)?.try_into().ok()?;
    Some(Pubkey::new_from_array(bytes))
}

fn word_at(body: &[u8], at: usize) -> Option<[u8; 8]> {
    body.get(at..at.checked_add(8)?)?.try_into().ok()
}

pub fn board_terms(data: &[u8]) -> Option<BoardTerms> {
    if data.get(..ClaimBoard::DISCRIMINATOR.len()) != Some(ClaimBoard::DISCRIMINATOR) {
        return None;
    }
    let body = data.get(ClaimBoard::DISCRIMINATOR.len()..)?;
    Some(BoardTerms {
        intent: key_at(body, offset_of!(ClaimBoard, intent))?,
        owner: key_at(body, offset_of!(ClaimBoard, owner))?,
        worker: key_at(body, offset_of!(ClaimBoard, worker))?,
        until: i64::from_le_bytes(word_at(body, offset_of!(ClaimBoard, until))?),
        held: u64::from_le_bytes(word_at(body, offset_of!(ClaimBoard, held))?),
    })
}

pub fn line_intent(data: &[u8]) -> Option<Pubkey> {
    if let Some(terms) = board_terms(data) {
        return Some(terms.intent);
    }
    if data.get(..ClaimList::DISCRIMINATOR.len()) == Some(ClaimList::DISCRIMINATOR) {
        let body = data.get(ClaimList::DISCRIMINATOR.len()..)?;
        return key_at(body, offset_of!(ClaimList, intent));
    }
    if data.get(..Standby::DISCRIMINATOR.len()) != Some(Standby::DISCRIMINATOR) {
        return None;
    }
    let body = data.get(Standby::DISCRIMINATOR.len()..)?;
    key_at(body, offset_of!(Standby, intent))
}

pub const LEGACY_CONFIG_SPACE: usize = 216;
pub const FIRST_VERSION: u8 = 1;
pub const UNVERSIONED: u8 = 0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Outdated {
    pub discriminator: &'static [u8],
    pub space: usize,
    pub version: u8,
}

const fn outdated(discriminator: &'static [u8], space: usize, version: u8) -> Outdated {
    Outdated {
        discriminator,
        space,
        version,
    }
}

pub const OUTDATED: [Outdated; 11] = [
    outdated(Config::DISCRIMINATOR, LEGACY_CONFIG_SPACE, FIRST_VERSION),
    outdated(Config::DISCRIMINATOR, Config::SPACE, FIRST_VERSION),
    outdated(UserState::DISCRIMINATOR, UserState::SPACE, FIRST_VERSION),
    outdated(Intent::DISCRIMINATOR, Intent::SPACE, FIRST_VERSION),
    outdated(Mandate::DISCRIMINATOR, Mandate::SPACE, FIRST_VERSION),
    outdated(MintCap::DISCRIMINATOR, MintCap::SPACE, FIRST_VERSION),
    outdated(Committee::DISCRIMINATOR, Committee::SPACE, FIRST_VERSION),
    outdated(ClaimBoard::DISCRIMINATOR, LEGACY_BOARD_SPACE, FIRST_VERSION),
    outdated(ClaimBoard::DISCRIMINATOR, ClaimBoard::SPACE, FIRST_VERSION),
    outdated(Standby::DISCRIMINATOR, Standby::SPACE, UNVERSIONED),
    outdated(Profile::DISCRIMINATOR, Profile::SPACE, FIRST_VERSION),
];

pub fn migration_of(data: &[u8]) -> Option<(&'static Layout, &'static Outdated)> {
    let (layout, version) = stored_version(data)?;
    let from = OUTDATED.iter().find(|o| {
        o.discriminator == layout.discriminator && o.space == data.len() && o.version == version
    })?;
    Some((layout, from))
}

pub fn config_terms(data: &[u8]) -> Option<Config> {
    if data.get(..Config::DISCRIMINATOR.len()) != Some(Config::DISCRIMINATOR) {
        return None;
    }
    let readable = is_current(data) || migration_of(data).is_some();
    if !readable {
        return None;
    }
    let body = data.get(Config::DISCRIMINATOR.len()..)?;
    let mut config = <Config as bytemuck::Zeroable>::zeroed();
    let view = bytemuck::bytes_of_mut(&mut config);
    let shared = view.len().min(body.len());
    view.get_mut(..shared)?.copy_from_slice(body.get(..shared)?);
    Some(config)
}

pub fn is_delivery_record(data: &[u8]) -> bool {
    [
        DeliveryBook::DISCRIMINATOR,
        Announcement::DISCRIMINATOR,
        Refutation::DISCRIMINATOR,
    ]
    .iter()
    .any(|disc| data.get(..disc.len()) == Some(*disc))
}
