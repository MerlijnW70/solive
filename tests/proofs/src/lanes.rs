use intent_core::mandate::{in_lane, is_mandated_nonce, lane_of, MAX_LANE_SERIAL};
use intent_core::nonce::{
    epoch_jump_allowed, nonce_jump_allowed, MAX_EPOCH_JUMP, MAX_NONCE_JUMP, NONCE_CEILING,
    WINDOW_BITS,
};

#[kani::proof]
fn no_allowed_advance_lets_an_owner_window_reach_an_agent_lane() {
    let base: u64 = kani::any();
    let new_base: u64 = kani::any();
    if nonce_jump_allowed(base, new_base) {
        assert!(new_base >= base && new_base - base <= MAX_NONCE_JUMP);
        assert!(new_base <= NONCE_CEILING);
        assert!(!is_mandated_nonce(new_base + (WINDOW_BITS - 1)));
    }
}

#[kani::proof]
fn epochs_only_move_forward_and_boundedly() {
    let epoch: u64 = kani::any();
    let next: u64 = kani::any();
    assert_eq!(
        epoch_jump_allowed(epoch, next),
        next >= epoch && next - epoch <= MAX_EPOCH_JUMP
    );
}

#[kani::proof]
fn every_nonce_belongs_to_at_most_one_agent_lane() {
    let nonce: u64 = kani::any();
    let a: u64 = kani::any();
    let b: u64 = kani::any();
    if in_lane(nonce, a) {
        assert!(is_mandated_nonce(nonce));
        assert!(a >= 1 && a <= MAX_LANE_SERIAL);
        if in_lane(nonce, b) {
            assert_eq!(a, b);
        }
    }
    if let (Some(x), Some(y)) = (lane_of(a), lane_of(b)) {
        assert_eq!(x == y, a == b);
    }
}
