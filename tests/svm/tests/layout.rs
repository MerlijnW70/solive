use anchor_spl::token_2022::spl_token_2022::extension::ExtensionType;
use core::mem::offset_of;
use intent_core::mint_policy::{
    ALLOWED_MINT_EXTENSIONS, GROUP_MEMBER_POINTER, GROUP_POINTER, INTEREST_BEARING_CONFIG,
    METADATA_POINTER, SCALED_UI_AMOUNT, TOKEN_GROUP, TOKEN_GROUP_MEMBER, TOKEN_METADATA,
};
use intent_core::Error as CoreError;
use intent_engine::errors::{core_err, EngineError};
use intent_engine::state::{
    ClaimBoard, Config, Intent, Mandate, MintCap, Standby, UserState, CLAIMS_SEED, COMMITTEE_SEED,
    CONFIG_SEED, DELEGATE_SEED, INTENT_SEED, MANDATE_SEED, MINT_CAP_SEED, PROFILE_SEED,
    STANDBY_SEED, USER_SEED, VAULT_SEED,
};

#[test]
fn account_sizes_are_frozen() {
    assert_eq!(Config::SPACE, 536);
    assert_eq!(UserState::SPACE, 152);
    assert_eq!(Intent::SPACE, 464);
    assert_eq!(Mandate::SPACE, 384);
    assert_eq!(ClaimBoard::SPACE, 176);
    assert_eq!(Standby::SPACE, 88);
}

#[test]
fn config_field_offsets_are_frozen() {
    assert_eq!(offset_of!(Config, admin), 0);
    assert_eq!(offset_of!(Config, pending_admin), 32);
    assert_eq!(offset_of!(Config, guardian), 64);
    assert_eq!(offset_of!(Config, fee_recipient), 96);
    assert_eq!(offset_of!(Config, enabled_kinds), 128);
    assert_eq!(offset_of!(Config, fee_bps), 136);
    assert_eq!(offset_of!(Config, paused), 138);
    assert_eq!(offset_of!(Config, version), 139);
    assert_eq!(offset_of!(Config, bump), 140);
    assert_eq!(offset_of!(Config, kind_fee_mask), 141);
    assert_eq!(offset_of!(Config, partner_cut_bps), 142);
    assert_eq!(offset_of!(Config, domain), 144);
    assert_eq!(offset_of!(Config, fill_disabled_kinds), 176);
    assert_eq!(offset_of!(Config, kind_fee_bps), 184);
    assert_eq!(offset_of!(Config, crank_bounty), 192);
    assert_eq!(offset_of!(Config, create_fee), 196);
    assert_eq!(offset_of!(Config, caps_required), 200);
    assert_eq!(offset_of!(Config, reserved), 201);
    assert_eq!(offset_of!(Config, floor_mints), 208);
    assert_eq!(offset_of!(Config, floor_amounts), 464);
}

#[test]
fn mint_cap_field_offsets_are_frozen() {
    assert_eq!(MintCap::SPACE, 136);
    assert_eq!(offset_of!(MintCap, mint), 0);
    assert_eq!(offset_of!(MintCap, max_per_order), 32);
    assert_eq!(offset_of!(MintCap, window_cap), 40);
    assert_eq!(offset_of!(MintCap, window_start), 48);
    assert_eq!(offset_of!(MintCap, window_used), 56);
    assert_eq!(offset_of!(MintCap, window_secs), 64);
    assert_eq!(offset_of!(MintCap, version), 68);
    assert_eq!(offset_of!(MintCap, bump), 69);
    assert_eq!(offset_of!(MintCap, padding), 70);
    assert_eq!(offset_of!(MintCap, total_limit), 72);
    assert_eq!(offset_of!(MintCap, outstanding), 80);
    assert_eq!(offset_of!(MintCap, reserved), 88);
}

#[test]
fn user_state_field_offsets_are_frozen() {
    assert_eq!(offset_of!(UserState, owner), 0);
    assert_eq!(offset_of!(UserState, nonce_base), 32);
    assert_eq!(offset_of!(UserState, nonce_bitmap), 40);
    assert_eq!(offset_of!(UserState, version), 72);
    assert_eq!(offset_of!(UserState, bump), 73);
    assert_eq!(offset_of!(UserState, padding), 74);
    assert_eq!(offset_of!(UserState, epoch), 80);
    assert_eq!(offset_of!(UserState, grants), 88);
    assert_eq!(offset_of!(UserState, reserved), 96);
}

#[test]
fn intent_field_offsets_are_frozen() {
    assert_eq!(offset_of!(Intent, owner), 0);
    assert_eq!(offset_of!(Intent, input_mint), 32);
    assert_eq!(offset_of!(Intent, output_mint), 64);
    assert_eq!(offset_of!(Intent, receiver), 96);
    assert_eq!(offset_of!(Intent, nonce), 128);
    assert_eq!(offset_of!(Intent, escrowed), 136);
    assert_eq!(offset_of!(Intent, created_at), 144);
    assert_eq!(offset_of!(Intent, expires_at), 152);
    assert_eq!(offset_of!(Intent, kind), 160);
    assert_eq!(offset_of!(Intent, status), 161);
    assert_eq!(offset_of!(Intent, bump), 162);
    assert_eq!(offset_of!(Intent, vault_bump), 163);
    assert_eq!(offset_of!(Intent, version), 164);
    assert_eq!(offset_of!(Intent, padding), 165);
    assert_eq!(offset_of!(Intent, flags), 166);
    assert_eq!(offset_of!(Intent, params), 168);
    assert_eq!(offset_of!(Intent, rent_payer), 296);
    assert_eq!(offset_of!(Intent, filled), 328);
    assert_eq!(offset_of!(Intent, revision), 336);
    assert_eq!(offset_of!(Intent, partner_bps), 340);
    assert_eq!(offset_of!(Intent, partner_cut_bps), 342);
    assert_eq!(offset_of!(Intent, in_flight), 344);
    assert_eq!(offset_of!(Intent, partner), 352);
    assert_eq!(offset_of!(Intent, bounty), 384);
    assert_eq!(offset_of!(Intent, mandate), 388);
    assert_eq!(offset_of!(Intent, fee_bps), 420);
    assert_eq!(offset_of!(Intent, gap), 422);
    assert_eq!(offset_of!(Intent, mandate_serial), 424);
    assert_eq!(offset_of!(Intent, agent_fee), 432);
    assert_eq!(offset_of!(Intent, claims), 440);
    assert_eq!(offset_of!(Intent, gap2), 441);
    assert_eq!(offset_of!(Intent, capped), 448);
}

#[test]
fn mandate_field_offsets_are_frozen() {
    assert_eq!(offset_of!(Mandate, owner), 0);
    assert_eq!(offset_of!(Mandate, agent), 32);
    assert_eq!(offset_of!(Mandate, input_mint), 64);
    assert_eq!(offset_of!(Mandate, output_mint), 96);
    assert_eq!(offset_of!(Mandate, partner), 128);
    assert_eq!(offset_of!(Mandate, input_account), 160);
    assert_eq!(offset_of!(Mandate, output_account), 192);
    assert_eq!(offset_of!(Mandate, id), 224);
    assert_eq!(offset_of!(Mandate, epoch), 232);
    assert_eq!(offset_of!(Mandate, valid_until), 240);
    assert_eq!(offset_of!(Mandate, max_ttl), 248);
    assert_eq!(offset_of!(Mandate, per_intent), 256);
    assert_eq!(offset_of!(Mandate, total), 264);
    assert_eq!(offset_of!(Mandate, spent), 272);
    assert_eq!(offset_of!(Mandate, floor_out), 280);
    assert_eq!(offset_of!(Mandate, floor_in), 288);
    assert_eq!(offset_of!(Mandate, max_intents), 296);
    assert_eq!(offset_of!(Mandate, intents), 300);
    assert_eq!(offset_of!(Mandate, partner_bps), 304);
    assert_eq!(offset_of!(Mandate, kinds), 306);
    assert_eq!(offset_of!(Mandate, version), 307);
    assert_eq!(offset_of!(Mandate, bump), 308);
    assert_eq!(offset_of!(Mandate, padding), 309);
    assert_eq!(offset_of!(Mandate, serial), 312);
    assert_eq!(offset_of!(Mandate, agent_fee), 320);
    assert_eq!(offset_of!(Mandate, reserved), 328);
}

#[test]
fn the_pinned_config_address_is_the_config_pda() {
    assert_eq!(
        intent_engine::state::CONFIG_ADDRESS,
        anchor_lang::prelude::Pubkey::find_program_address(&[CONFIG_SEED], &intent_engine::ID).0
    );
}

#[test]
fn pda_seed_preimages_cannot_collide() {
    let shapes: [(&[u8], usize); 11] = [
        (CONFIG_SEED, 0),
        (USER_SEED, 32),
        (INTENT_SEED, 40),
        (VAULT_SEED, 32),
        (DELEGATE_SEED, 32),
        (MANDATE_SEED, 72),
        (MINT_CAP_SEED, 32),
        (COMMITTEE_SEED, 32),
        (CLAIMS_SEED, 32),
        (PROFILE_SEED, 32),
        (STANDBY_SEED, 36),
    ];
    for (i, (a, a_tail)) in shapes.iter().enumerate() {
        for (b, b_tail) in shapes.iter().skip(i + 1) {
            assert!(!a.starts_with(b) && !b.starts_with(a), "{a:?} {b:?}");
            let same_shape = a.len() == b.len() && a_tail == b_tail;
            assert!(
                same_shape || a.len() + a_tail != b.len() + b_tail,
                "{a:?} {b:?}"
            );
        }
    }
}

#[test]
fn mint_policy_codes_match_token_2022_extension_types() {
    let pairs = [
        (
            INTEREST_BEARING_CONFIG,
            ExtensionType::InterestBearingConfig,
        ),
        (METADATA_POINTER, ExtensionType::MetadataPointer),
        (TOKEN_METADATA, ExtensionType::TokenMetadata),
        (GROUP_POINTER, ExtensionType::GroupPointer),
        (TOKEN_GROUP, ExtensionType::TokenGroup),
        (GROUP_MEMBER_POINTER, ExtensionType::GroupMemberPointer),
        (TOKEN_GROUP_MEMBER, ExtensionType::TokenGroupMember),
        (SCALED_UI_AMOUNT, ExtensionType::ScaledUiAmount),
    ];
    for (code, ty) in pairs {
        assert_eq!(code, u16::from(ty), "{ty:?}");
    }
    assert_eq!(ALLOWED_MINT_EXTENSIONS.len(), pairs.len());
}

#[test]
fn transfer_altering_extensions_stay_outside_allowlist() {
    for ty in [
        ExtensionType::MintCloseAuthority,
        ExtensionType::TransferFeeConfig,
        ExtensionType::ConfidentialTransferMint,
        ExtensionType::DefaultAccountState,
        ExtensionType::NonTransferable,
        ExtensionType::PermanentDelegate,
        ExtensionType::TransferHook,
        ExtensionType::ConfidentialTransferFeeConfig,
        ExtensionType::Pausable,
    ] {
        assert!(!ALLOWED_MINT_EXTENSIONS.contains(&u16::from(ty)), "{ty:?}");
    }
}

#[test]
fn engine_errors_start_at_anchor_offset() {
    assert_eq!(u32::from(EngineError::Overflow), 6000);
    assert_eq!(u32::from(EngineError::NonceRegression), 6014);
    assert_eq!(u32::from(EngineError::MintNotAllowed), 6024);
    assert_eq!(u32::from(EngineError::AuctionOutlivesExpiry), 6027);
    assert_eq!(u32::from(EngineError::FillPaused), 6028);
    assert_eq!(u32::from(EngineError::FeeAccountNotCanonical), 6029);
    assert_eq!(u32::from(EngineError::FeeAccountMissing), 6030);
    assert_eq!(u32::from(EngineError::SolverOutputNotAllowed), 6031);
    assert_eq!(u32::from(EngineError::SigProgram), 6032);
    assert_eq!(u32::from(EngineError::SigHeader), 6033);
    assert_eq!(u32::from(EngineError::SigPubkey), 6034);
    assert_eq!(u32::from(EngineError::SigMessage), 6035);
    assert_eq!(u32::from(EngineError::KindMismatch), 6036);
    assert_eq!(u32::from(EngineError::ResultOutOfBounds), 6037);
    assert_eq!(u32::from(EngineError::SigMissing), 6038);
    assert_eq!(u32::from(EngineError::InvalidDomain), 6039);
    assert_eq!(u32::from(EngineError::SignatureExpired), 6040);
    assert_eq!(u32::from(EngineError::FlashCpi), 6041);
    assert_eq!(u32::from(EngineError::FlashEndProgram), 6042);
    assert_eq!(u32::from(EngineError::FlashEndDiscriminator), 6043);
    assert_eq!(u32::from(EngineError::FlashEndIntent), 6044);
    assert_eq!(u32::from(EngineError::FlashEndOrder), 6045);
    assert_eq!(u32::from(EngineError::ReceiverCannotReceive), 6046);
    assert_eq!(u32::from(EngineError::RefundCannotReceive), 6047);
    assert_eq!(u32::from(EngineError::FeeAboveBound), 6048);
    assert_eq!(u32::from(EngineError::ExtTooLong), 6049);
    assert_eq!(u32::from(EngineError::ExtMalformed), 6050);
    assert_eq!(u32::from(EngineError::ExtUnknown), 6051);
    assert_eq!(u32::from(EngineError::FlagsUnknown), 6052);
    assert_eq!(u32::from(EngineError::FillKindDisabled), 6053);
    assert_eq!(u32::from(EngineError::UnsupportedVersion), 6054);
    assert_eq!(u32::from(EngineError::AmountInMismatch), 6055);
    assert_eq!(u32::from(EngineError::EpochRegression), 6056);
    assert_eq!(u32::from(EngineError::TreasuryMismatch), 6057);
    assert_eq!(u32::from(EngineError::CrankBountyTooHigh), 6058);
    assert_eq!(u32::from(EngineError::CreateFeeTooHigh), 6059);
    assert_eq!(u32::from(EngineError::PartnerCutTooHigh), 6060);
    assert_eq!(u32::from(EngineError::PartnerFeeTooHigh), 6061);
    assert_eq!(u32::from(EngineError::PartnerAccountMissing), 6062);
    assert_eq!(u32::from(EngineError::PartnerAccountNotCanonical), 6063);
    assert_eq!(u32::from(EngineError::MandateInvalid), 6064);
    assert_eq!(u32::from(EngineError::MandateExpired), 6065);
    assert_eq!(u32::from(EngineError::MandateKind), 6066);
    assert_eq!(u32::from(EngineError::MandateTtl), 6067);
    assert_eq!(u32::from(EngineError::MandateCap), 6068);
    assert_eq!(u32::from(EngineError::MandateBudget), 6069);
    assert_eq!(u32::from(EngineError::MandateCount), 6070);
    assert_eq!(u32::from(EngineError::MandatePrice), 6071);
    assert_eq!(u32::from(EngineError::MandateRevoked), 6072);
    assert_eq!(u32::from(EngineError::MandateMismatch), 6073);
    assert_eq!(u32::from(EngineError::CreateCostAboveCeiling), 6074);
    assert_eq!(u32::from(EngineError::NonceJumpTooLarge), 6075);
    assert_eq!(u32::from(EngineError::EpochJumpTooLarge), 6076);
    assert_eq!(u32::from(EngineError::SplitNotConserved), 6080);
    assert_eq!(u32::from(EngineError::MintCapMissing), 6081);
    assert_eq!(u32::from(EngineError::MintCapMismatch), 6082);
    assert_eq!(u32::from(EngineError::MintCapPerOrder), 6083);
    assert_eq!(u32::from(EngineError::MintCapWindow), 6084);
    assert_eq!(u32::from(EngineError::MintCapInvalid), 6085);
}

#[test]
fn core_errors_map_to_same_named_engine_errors() {
    let pairs = [
        (CoreError::Overflow, EngineError::Overflow),
        (CoreError::DivideByZero, EngineError::DivideByZero),
        (CoreError::Truncated, EngineError::Truncated),
        (CoreError::NonCanonical, EngineError::NonCanonical),
        (CoreError::UnknownKind, EngineError::UnknownKind),
        (CoreError::UnknownStatus, EngineError::UnknownStatus),
        (CoreError::InvalidParams, EngineError::InvalidParams),
        (CoreError::AmountMismatch, EngineError::AmountMismatch),
        (
            CoreError::InsufficientOutput,
            EngineError::InsufficientOutput,
        ),
        (CoreError::InvalidTransition, EngineError::InvalidTransition),
        (CoreError::IntentExpired, EngineError::IntentExpired),
        (CoreError::NotExpired, EngineError::NotExpired),
        (CoreError::NonceUsed, EngineError::NonceUsed),
        (CoreError::NonceOutOfWindow, EngineError::NonceOutOfWindow),
        (CoreError::NonceRegression, EngineError::NonceRegression),
        (CoreError::SigProgram, EngineError::SigProgram),
        (CoreError::SigHeader, EngineError::SigHeader),
        (CoreError::SigPubkey, EngineError::SigPubkey),
        (CoreError::SigMessage, EngineError::SigMessage),
        (CoreError::KindMismatch, EngineError::KindMismatch),
        (CoreError::ResultOutOfBounds, EngineError::ResultOutOfBounds),
        (CoreError::FlashEndProgram, EngineError::FlashEndProgram),
        (
            CoreError::FlashEndDiscriminator,
            EngineError::FlashEndDiscriminator,
        ),
        (CoreError::FlashEndIntent, EngineError::FlashEndIntent),
        (CoreError::ExtTooLong, EngineError::ExtTooLong),
        (CoreError::ExtMalformed, EngineError::ExtMalformed),
        (CoreError::ExtUnknown, EngineError::ExtUnknown),
        (CoreError::FlagsUnknown, EngineError::FlagsUnknown),
        (CoreError::PartnerFeeTooHigh, EngineError::PartnerFeeTooHigh),
        (CoreError::MandateInvalid, EngineError::MandateInvalid),
        (CoreError::MandateExpired, EngineError::MandateExpired),
        (CoreError::MandateKind, EngineError::MandateKind),
        (CoreError::MandateTtl, EngineError::MandateTtl),
        (CoreError::MandateCap, EngineError::MandateCap),
        (CoreError::MandateBudget, EngineError::MandateBudget),
        (CoreError::MandateCount, EngineError::MandateCount),
        (CoreError::MandatePrice, EngineError::MandatePrice),
    ];
    for (core, engine) in pairs {
        assert_eq!(u32::from(core_err(core)), u32::from(engine), "{core:?}");
    }
}

#[test]
fn core_ed25519_program_id_matches_the_runtime() {
    let ix =
        solana_ed25519_program::new_ed25519_instruction_with_signature(&[1], &[0; 64], &[0; 32]);
    assert_eq!(
        intent_core::sig::ED25519_PROGRAM_ID,
        ix.program_id.to_bytes()
    );
}
