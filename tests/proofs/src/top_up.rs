use intent_core::migrate::top_up;

#[kani::proof]
fn a_migration_top_up_never_lowers_lamports_and_covers_rent_and_stake() {
    let lamports: u64 = kani::any();
    let held: u64 = kani::any();
    let from_min: u64 = kani::any();
    let to_min: u64 = kani::any();
    let added = top_up(lamports, held, from_min, to_min);
    let after = lamports.checked_add(added);
    assert!(after.is_some());
    let Some(after) = after else {
        return;
    };
    assert!(after >= lamports);
    assert!(after >= to_min.saturating_add(held));
    if let Some(need) = to_min.checked_add(held) {
        assert!(after >= need);
    }
    let fits = to_min >= from_min && lamports.checked_add(to_min - from_min).is_some();
    if lamports >= from_min && fits {
        assert!(after - to_min >= lamports - from_min);
    }
}
