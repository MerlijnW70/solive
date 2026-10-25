use intent_core::lifecycle::Status;
use intent_engine::errors::EngineError;
use intent_engine::instructions::open_claims::open_terms;
use intent_engine::state::{Intent, CLAIMS_OPEN};

const NOW: i64 = 1_700_000_000;
const HOUR: u32 = 3_600;
const STAKE: u64 = 50_000_000;

fn open_intent(claims: u8) -> Intent {
    let mut intent: Intent = bytemuck::Zeroable::zeroed();
    intent.status = Status::Open as u8;
    intent.expires_at = NOW.saturating_add(i64::from(HOUR));
    intent.claims = claims;
    intent
}

#[test]
fn claims_already_open_on_an_escrow_are_refused_before_its_terms_are_read() {
    let mut intent = open_intent(CLAIMS_OPEN);
    let refused = open_terms(&mut intent, NOW, HOUR, STAKE).err();
    assert_eq!(refused, Some(EngineError::ClaimsOpen.into()));
    assert_eq!(intent.claims, CLAIMS_OPEN);
}

#[test]
fn claims_on_an_escrow_without_them_go_on_to_its_terms() {
    let mut intent = open_intent(0);
    let refused = open_terms(&mut intent, NOW, HOUR, STAKE).err();
    assert_ne!(refused, Some(EngineError::ClaimsOpen.into()));
}
