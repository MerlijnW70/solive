use intent_core::migrate::top_up;

#[test]
fn growing_adds_the_rent_difference() {
    assert_eq!(top_up(1_000, 0, 1_000, 1_500), 500);
    assert_eq!(top_up(1_200, 0, 1_000, 1_500), 500);
}

#[test]
fn a_held_stake_stays_covered_on_top_of_the_new_rent() {
    assert_eq!(top_up(1_000, 400, 1_000, 1_500), 900);
    assert_eq!(top_up(1_400, 400, 1_000, 1_500), 500);
}

#[test]
fn an_account_already_covered_gets_nothing_and_never_loses_lamports() {
    assert_eq!(top_up(5_000, 400, 1_500, 1_500), 0);
    assert_eq!(top_up(5_000, 0, 2_000, 1_500), 0);
    assert_eq!(top_up(u64::MAX, u64::MAX, 0, u64::MAX), 0);
}
