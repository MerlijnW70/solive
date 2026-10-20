use anchor_lang::Discriminator;
use core::mem::{offset_of, size_of};
use intent_engine::state::{
    ClaimBoard, Committee, Config, Intent, Mandate, MintCap, Profile, Standby, UserState,
};
use intent_engine::versions::{
    migration_of, Outdated, FIRST_VERSION, LAYOUTS, LEGACY_BOARD_SPACE, LEGACY_CONFIG_SPACE,
    OUTDATED, UNVERSIONED,
};

#[allow(dead_code)]
mod stand_by_line {
    use intent_core::committee::MAX_MEMBERS;
    use intent_core::profile::{MAX_SKILLS, MAX_URL_LEN, SKILL_LEN};
    use intent_core::PARAMS_LEN;

    type Key = [u8; 32];

    #[repr(C)]
    pub struct Config {
        pub admin: Key,
        pub pending_admin: Key,
        pub guardian: Key,
        pub fee_recipient: Key,
        pub enabled_kinds: u64,
        pub fee_bps: u16,
        pub paused: u8,
        pub version: u8,
        pub bump: u8,
        pub kind_fee_mask: u8,
        pub partner_cut_bps: u16,
        pub domain: [u8; 32],
        pub fill_disabled_kinds: u64,
        pub kind_fee_bps: [u16; 4],
        pub crank_bounty: u32,
        pub create_fee: u32,
        pub caps_required: u8,
        pub reserved: [u8; 7],
    }

    #[repr(C)]
    pub struct UserState {
        pub owner: Key,
        pub nonce_base: u64,
        pub nonce_bitmap: [u64; 4],
        pub version: u8,
        pub bump: u8,
        pub padding: [u8; 6],
        pub epoch: u64,
        pub grants: u64,
        pub reserved: [u8; 48],
    }

    #[repr(C)]
    pub struct Intent {
        pub owner: Key,
        pub input_mint: Key,
        pub output_mint: Key,
        pub receiver: Key,
        pub nonce: u64,
        pub escrowed: u64,
        pub created_at: i64,
        pub expires_at: i64,
        pub kind: u8,
        pub status: u8,
        pub bump: u8,
        pub vault_bump: u8,
        pub version: u8,
        pub padding: [u8; 1],
        pub flags: u16,
        pub params: [u8; PARAMS_LEN],
        pub rent_payer: Key,
        pub filled: u64,
        pub revision: u32,
        pub partner_bps: u16,
        pub partner_cut_bps: u16,
        pub in_flight: u64,
        pub partner: Key,
        pub bounty: u32,
        pub mandate: Key,
        pub gap: [u8; 4],
        pub mandate_serial: u64,
        pub agent_fee: u64,
        pub claims: u8,
        pub reserved: [u8; 15],
    }

    #[repr(C)]
    pub struct Mandate {
        pub owner: Key,
        pub agent: Key,
        pub input_mint: Key,
        pub output_mint: Key,
        pub partner: Key,
        pub input_account: Key,
        pub output_account: Key,
        pub id: u64,
        pub epoch: u64,
        pub valid_until: i64,
        pub max_ttl: i64,
        pub per_intent: u64,
        pub total: u64,
        pub spent: u64,
        pub floor_out: u64,
        pub floor_in: u64,
        pub max_intents: u32,
        pub intents: u32,
        pub partner_bps: u16,
        pub kinds: u8,
        pub version: u8,
        pub bump: u8,
        pub padding: [u8; 3],
        pub serial: u64,
        pub agent_fee: u64,
        pub reserved: [u8; 48],
    }

    #[repr(C)]
    pub struct MintCap {
        pub mint: Key,
        pub max_per_order: u64,
        pub window_cap: u64,
        pub window_start: i64,
        pub window_used: u64,
        pub window_secs: u32,
        pub version: u8,
        pub bump: u8,
        pub padding: [u8; 2],
        pub reserved: [u8; 56],
    }

    #[repr(C)]
    pub struct Committee {
        pub members: [Key; MAX_MEMBERS],
        pub fee_wallet: Key,
        pub id: [u8; 32],
        pub created_at: i64,
        pub threshold: u8,
        pub count: u8,
        pub version: u8,
        pub bump: u8,
        pub padding: [u8; 4],
        pub reserved: [u8; 64],
    }

    #[repr(C)]
    pub struct ClaimBoard {
        pub intent: Key,
        pub owner: Key,
        pub worker: Key,
        pub until: i64,
        pub stake: u64,
        pub held: u64,
        pub max_secs: u32,
        pub version: u8,
        pub bump: u8,
        pub padding: [u8; 2],
        pub dropped_by: Key,
        pub head: u32,
        pub tail: u32,
    }

    #[repr(C)]
    pub struct LineFreeBoard {
        pub intent: Key,
        pub owner: Key,
        pub worker: Key,
        pub until: i64,
        pub stake: u64,
        pub held: u64,
        pub max_secs: u32,
        pub version: u8,
        pub bump: u8,
        pub padding: [u8; 2],
        pub dropped_by: Key,
    }

    #[repr(C)]
    pub struct Standby {
        pub worker: Key,
        pub intent: Key,
        pub seq: u32,
        pub secs: u32,
        pub bump: u8,
        pub padding: [u8; 7],
    }

    #[repr(C)]
    pub struct Profile {
        pub wallet: Key,
        pub doc_hash: [u8; 32],
        pub updated_at: i64,
        pub skills: [[u8; SKILL_LEN]; MAX_SKILLS],
        pub endpoint: [u8; MAX_URL_LEN],
        pub doc_url: [u8; MAX_URL_LEN],
        pub version: u8,
        pub bump: u8,
        pub padding: [u8; 6],
        pub reserved: [u8; 32],
    }
}

macro_rules! offsets {
    ($ty:ty, [$($field:ident),* $(,)?]) => {
        [$(offset_of!($ty, $field)),*]
    };
}

macro_rules! kept {
    ($old:ty, $new:ty, [$($field:ident),* $(,)?]) => {
        $(assert_eq!(offset_of!($old, $field), offset_of!($new, $field), stringify!($field));)*
    };
}

const HEAD: usize = 8;

fn space_of<T>() -> usize {
    HEAD.saturating_add(size_of::<T>())
}

#[test]
fn the_stand_by_line_layouts_are_pinned() {
    use stand_by_line as old;
    assert_eq!(
        [
            space_of::<old::Config>(),
            space_of::<old::UserState>(),
            space_of::<old::Intent>(),
            space_of::<old::Mandate>(),
            space_of::<old::MintCap>(),
            space_of::<old::Committee>(),
            space_of::<old::ClaimBoard>(),
            space_of::<old::LineFreeBoard>(),
            space_of::<old::Standby>(),
            space_of::<old::Profile>(),
        ],
        [216, 152, 464, 384, 136, 408, 176, 168, 88, 504]
    );
    assert_eq!(
        offsets!(
            old::Config,
            [
                admin,
                pending_admin,
                guardian,
                fee_recipient,
                enabled_kinds,
                fee_bps,
                paused,
                version,
                bump,
                kind_fee_mask,
                partner_cut_bps,
                domain,
                fill_disabled_kinds,
                kind_fee_bps,
                crank_bounty,
                create_fee,
                caps_required,
                reserved
            ]
        ),
        [0, 32, 64, 96, 128, 136, 138, 139, 140, 141, 142, 144, 176, 184, 192, 196, 200, 201]
    );
    assert_eq!(
        offsets!(
            old::Intent,
            [
                rent_payer,
                filled,
                in_flight,
                bounty,
                mandate,
                gap,
                mandate_serial,
                agent_fee,
                claims,
                reserved
            ]
        ),
        [296, 328, 344, 384, 388, 420, 424, 432, 440, 441]
    );
    assert_eq!(
        offsets!(
            old::MintCap,
            [window_secs, version, bump, padding, reserved]
        ),
        [64, 68, 69, 70, 72]
    );
    assert_eq!(
        offsets!(
            old::Committee,
            [fee_wallet, id, created_at, threshold, count, version, reserved]
        ),
        [256, 288, 320, 328, 329, 330, 336]
    );
    assert_eq!(
        offsets!(
            old::ClaimBoard,
            [until, held, max_secs, version, dropped_by, head, tail]
        ),
        [96, 112, 120, 124, 128, 160, 164]
    );
    assert_eq!(
        offsets!(old::Standby, [seq, secs, bump, padding]),
        [64, 68, 72, 73]
    );
    assert_eq!(
        offsets!(
            old::Profile,
            [updated_at, skills, endpoint, doc_url, version, reserved]
        ),
        [64, 72, 200, 328, 456, 464]
    );
}

#[test]
fn main_keeps_every_stand_by_line_field_where_it_was() {
    use stand_by_line as old;
    kept!(
        old::Config,
        Config,
        [
            admin,
            pending_admin,
            guardian,
            fee_recipient,
            enabled_kinds,
            fee_bps,
            paused,
            version,
            bump,
            kind_fee_mask,
            partner_cut_bps,
            domain,
            fill_disabled_kinds,
            kind_fee_bps,
            crank_bounty,
            create_fee,
            caps_required,
            reserved
        ]
    );
    kept!(
        old::UserState,
        UserState,
        [
            owner,
            nonce_base,
            nonce_bitmap,
            version,
            bump,
            padding,
            epoch,
            grants,
            reserved
        ]
    );
    kept!(
        old::Intent,
        Intent,
        [
            owner,
            input_mint,
            output_mint,
            receiver,
            nonce,
            escrowed,
            created_at,
            expires_at,
            kind,
            status,
            bump,
            vault_bump,
            version,
            padding,
            flags,
            params,
            rent_payer,
            filled,
            revision,
            partner_bps,
            partner_cut_bps,
            in_flight,
            partner,
            bounty,
            mandate,
            mandate_serial,
            agent_fee,
            claims
        ]
    );
    kept!(
        old::Mandate,
        Mandate,
        [
            owner,
            agent,
            input_mint,
            output_mint,
            partner,
            input_account,
            output_account,
            id,
            epoch,
            valid_until,
            max_ttl,
            per_intent,
            total,
            spent,
            floor_out,
            floor_in,
            max_intents,
            intents,
            partner_bps,
            kinds,
            version,
            bump,
            padding,
            serial,
            agent_fee,
            reserved
        ]
    );
    kept!(
        old::MintCap,
        MintCap,
        [
            mint,
            max_per_order,
            window_cap,
            window_start,
            window_used,
            window_secs,
            version,
            bump,
            padding
        ]
    );
    kept!(
        old::Committee,
        Committee,
        [members, fee_wallet, id, created_at, threshold, count, version, bump, padding, reserved]
    );
    kept!(
        old::ClaimBoard,
        ClaimBoard,
        [
            intent, owner, worker, until, stake, held, max_secs, version, bump, padding,
            dropped_by, head, tail
        ]
    );
    kept!(
        old::LineFreeBoard,
        ClaimBoard,
        [intent, owner, worker, until, stake, held, max_secs, version, bump, padding, dropped_by]
    );
    kept!(old::Standby, Standby, [worker, intent, seq, secs, bump]);
    kept!(
        old::Profile,
        Profile,
        [wallet, doc_hash, updated_at, skills, endpoint, doc_url, version, bump, padding]
    );
}

#[test]
fn main_puts_new_fields_only_where_the_stand_by_line_kept_zeros() {
    use stand_by_line as old;
    assert_eq!(
        offsets!(Config, [floor_mints, floor_amounts]),
        [size_of::<old::Config>(), 464]
    );
    assert_eq!(offset_of!(Intent, fee_bps), offset_of!(old::Intent, gap));
    assert_eq!(offsets!(Intent, [gap2, capped]), [441, 448]);
    assert_eq!(offset_of!(old::Intent, reserved), 441);
    assert_eq!(
        offsets!(MintCap, [total_limit, outstanding, created_at, reserved]),
        [offset_of!(old::MintCap, reserved), 80, 88, 96]
    );
    assert_eq!(
        offset_of!(Standby, version),
        offset_of!(old::Standby, padding)
    );
    assert_eq!(
        offsets!(ClaimBoard, [head, tail]),
        [size_of::<old::LineFreeBoard>(), 164]
    );
    assert_eq!(
        offset_of!(Profile, encryption_key),
        offset_of!(old::Profile, reserved)
    );
    assert_eq!(size_of::<Profile>(), size_of::<old::Profile>());
}

#[test]
fn every_outdated_layout_names_a_current_type_and_its_version_byte() {
    let expected: Vec<(usize, usize, u8, usize)> = vec![
        (0, LEGACY_CONFIG_SPACE, FIRST_VERSION, Config::SPACE),
        (0, Config::SPACE, FIRST_VERSION, Config::SPACE),
        (1, UserState::SPACE, FIRST_VERSION, UserState::SPACE),
        (2, Intent::SPACE, FIRST_VERSION, Intent::SPACE),
        (3, Mandate::SPACE, FIRST_VERSION, Mandate::SPACE),
        (4, MintCap::SPACE, FIRST_VERSION, MintCap::SPACE),
        (5, Committee::SPACE, FIRST_VERSION, Committee::SPACE),
        (6, LEGACY_BOARD_SPACE, FIRST_VERSION, ClaimBoard::SPACE),
        (6, ClaimBoard::SPACE, FIRST_VERSION, ClaimBoard::SPACE),
        (7, Standby::SPACE, UNVERSIONED, Standby::SPACE),
        (8, Profile::SPACE, FIRST_VERSION, Profile::SPACE),
    ];
    let found: Vec<(usize, usize, u8, usize)> = OUTDATED
        .iter()
        .map(|o: &Outdated| {
            let at = LAYOUTS
                .iter()
                .position(|l| l.discriminator == o.discriminator)
                .unwrap_or(usize::MAX);
            let space = LAYOUTS.get(at).map_or(0, |l| l.space);
            (at, o.space, o.version, space)
        })
        .collect();
    assert_eq!(found, expected);
    for o in OUTDATED {
        let layout = LAYOUTS.iter().find(|l| l.discriminator == o.discriminator);
        assert!(layout.is_some_and(|l| l.version_at < o.space.saturating_sub(HEAD)));
        assert!(layout.is_some_and(|l| l.version != o.version));
    }
}

#[test]
fn only_listed_outdated_layouts_migrate() {
    let mut data = Intent::DISCRIMINATOR.to_vec();
    data.resize(Intent::SPACE, 0);
    let version_at = HEAD.saturating_add(offset_of!(Intent, version));
    for (version, listed) in [(0u8, false), (1, true), (2, false), (3, false)] {
        if let Some(v) = data.get_mut(version_at) {
            *v = version;
        }
        assert_eq!(migration_of(&data).is_some(), listed, "version {version}");
    }
    if let Some(v) = data.get_mut(version_at) {
        *v = FIRST_VERSION;
    }
    data.push(0);
    assert!(migration_of(&data).is_none(), "a size no layout had");
    let unknown = vec![7u8; Intent::SPACE];
    assert!(
        migration_of(&unknown).is_none(),
        "a discriminator no type has"
    );
}
