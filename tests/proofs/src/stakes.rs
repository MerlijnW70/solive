use intent_core::claim::{stake_on_cancel, stake_on_release, stake_on_settle, Slot, StakeTo};

struct Decisions {
    slot: Slot,
    paid_worker: bool,
    release: Option<StakeTo>,
    cancel: Option<StakeTo>,
    settle_open: Option<Option<StakeTo>>,
    settle_closed: Option<Option<StakeTo>>,
}

fn decide() -> Decisions {
    let worker: [u8; 32] = kani::any();
    let slot = Slot::at(worker, kani::any(), kani::any());
    let mut payees: [[u8; 32]; 2] = kani::any();
    if kani::any() {
        payees[0] = worker;
    }
    let len: usize = kani::any();
    kani::assume(len <= payees.len());
    let chosen = &payees[..len];
    Decisions {
        slot,
        paid_worker: chosen.contains(&worker),
        release: stake_on_release(slot, chosen),
        cancel: stake_on_cancel(slot),
        settle_open: stake_on_settle(slot, true).ok(),
        settle_closed: stake_on_settle(slot, false).ok(),
    }
}

#[kani::proof]
#[kani::unwind(34)]
fn a_lapsed_stake_goes_to_the_owner_and_a_held_one_never_does() {
    let d = decide();
    let owner = Some(StakeTo::Owner);
    let worker = Some(StakeTo::Worker);
    match d.slot {
        Slot::Free => {
            assert_eq!(d.release, None);
            assert_eq!(d.cancel, None);
            assert_eq!(d.settle_open, Some(None));
            assert_eq!(d.settle_closed, Some(None));
        }
        Slot::Lapsed { .. } => {
            assert_eq!(d.release, owner);
            assert_eq!(d.cancel, owner);
            assert_eq!(d.settle_open, Some(owner));
            assert_eq!(d.settle_closed, Some(owner));
        }
        Slot::Held { .. } => {
            assert_ne!(d.release, owner);
            assert_ne!(d.cancel, owner);
            assert_eq!(d.settle_open, None);
            assert_ne!(d.settle_closed, Some(owner));
            assert_eq!(d.release == worker, d.paid_worker);
            assert_eq!(d.cancel, worker);
            assert_eq!(d.settle_closed, Some(worker));
        }
    }
}

#[kani::proof]
#[kani::unwind(34)]
fn every_path_that_pays_a_stake_pays_the_same_single_party() {
    let d = decide();
    let paths = [
        d.release,
        d.cancel,
        d.settle_open.flatten(),
        d.settle_closed.flatten(),
    ];
    let to_worker = paths.iter().any(|p| *p == Some(StakeTo::Worker));
    let to_owner = paths.iter().any(|p| *p == Some(StakeTo::Owner));
    assert!(!(to_worker && to_owner));
    assert_eq!(to_owner, matches!(d.slot, Slot::Lapsed { .. }));
    assert_eq!(to_worker, matches!(d.slot, Slot::Held { .. }));
}
