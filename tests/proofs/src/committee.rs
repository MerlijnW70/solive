use intent_core::committee::{Committee, MAX_MEMBERS};

macro_rules! each_count {
    ($count:expr, $check:ident) => {
        match $count {
            0 => $check::<0>(),
            1 => $check::<1>(),
            2 => $check::<2>(),
            3 => $check::<3>(),
            4 => $check::<4>(),
            5 => $check::<5>(),
            6 => $check::<6>(),
            7 => $check::<7>(),
            8 => $check::<8>(),
            _ => kani::assume(false),
        }
    };
}

fn any_count() -> usize {
    let count: usize = kani::any();
    kani::assume(count <= MAX_MEMBERS);
    count
}

fn keys<const N: usize>() -> [[u8; 32]; N] {
    let mut keys = [[0u8; 32]; N];
    for key in keys.iter_mut() {
        key[31] = kani::any();
    }
    keys
}

fn distinct<const N: usize>() -> [[u8; 32]; N] {
    let mut keys = [[0u8; 32]; N];
    for (position, key) in (1u8..).zip(keys.iter_mut()) {
        key[31] = position;
    }
    keys
}

fn named_by(mask: u8, members: usize) -> bool {
    u16::from(mask) >> members == 0
}

fn selects_the_named_members<const N: usize>() {
    let members: [[u8; 32]; N] = distinct();
    let Ok(committee) = Committee::new(&members, kani::any(), kani::any()) else {
        return;
    };
    let mask: u8 = kani::any();
    let Ok(signers) = committee.signers(mask) else {
        return;
    };
    let mut expected = [[0u8; 32]; MAX_MEMBERS];
    let mut len = 0usize;
    for (bit, member) in members.iter().enumerate() {
        if (mask >> bit) & 1 == 1 {
            expected[len] = *member;
            len += 1;
        }
    }
    let chosen = signers.keys();
    assert!(chosen.len() == len);
    for index in 0..N {
        if index < len {
            assert!(chosen[index] == expected[index]);
        }
    }
    for index in 1..N {
        if index < len {
            assert!(chosen[index - 1] < chosen[index]);
        }
    }
}

fn reaches_no_threshold<const N: usize>() {
    let members: [[u8; 32]; N] = kani::any();
    let threshold: u8 = kani::any();
    kani::assume(threshold == 0 || usize::from(threshold) > N);
    assert!(Committee::new(&members, threshold, kani::any()).is_err());
}

fn repeats_a_member<const N: usize>() {
    let mut members: [[u8; 32]; N] = keys();
    let first: usize = kani::any();
    let second: usize = kani::any();
    kani::assume(first < second && second < N);
    members[second] = members[first];
    assert!(Committee::new(&members, kani::any(), kani::any()).is_err());
}

fn stored_matches_new<const N: usize>() {
    let members: [[u8; 32]; N] = keys();
    let threshold: u8 = kani::any();
    let fee_wallet: [u8; 32] = kani::any();
    let mut stored = [[0u8; 32]; MAX_MEMBERS];
    stored[..N].copy_from_slice(&members);
    let fresh = Committee::new(&members, threshold, fee_wallet);
    let loaded = Committee::from_stored(threshold, N as u8, &stored, fee_wallet);
    assert!(fresh.err() == loaded.err());
    if let (Ok(fresh), Ok(loaded)) = (fresh, loaded) {
        assert!(same_preimage_input::<N>(&fresh, &loaded));
    }
}

fn same_preimage_input<const N: usize>(fresh: &Committee, loaded: &Committee) -> bool {
    let (left, right) = (fresh.members(), loaded.members());
    left.len() == N
        && right.len() == N
        && (0..N).all(|index| left[index] == right[index])
        && fresh.threshold() == loaded.threshold()
        && fresh.fee_wallet() == loaded.fee_wallet()
}

fn refuses_a_named_padding<const N: usize>() {
    let stored: [[u8; 32]; MAX_MEMBERS] = keys();
    let slot: usize = kani::any();
    kani::assume(N <= slot && slot < MAX_MEMBERS && stored[slot] != [0; 32]);
    assert!(Committee::from_stored(kani::any(), N as u8, &stored, kani::any()).is_err());
}

#[kani::proof]
#[kani::unwind(34)]
fn signers_succeeds_only_for_a_mask_within_the_members_that_meets_the_threshold() {
    let members: [[u8; 32]; MAX_MEMBERS] = keys();
    let count = any_count();
    let threshold: u8 = kani::any();
    let Ok(committee) = Committee::new(&members[..count], threshold, kani::any()) else {
        return;
    };
    let mask: u8 = kani::any();
    let expected = named_by(mask, count) && mask.count_ones() >= u32::from(threshold);
    assert!(committee.signers(mask).is_ok() == expected);
}

#[kani::proof]
#[kani::unwind(34)]
fn signers_of_one_member_are_the_named_members_in_order() {
    selects_the_named_members::<1>();
}

#[kani::proof]
#[kani::unwind(34)]
fn signers_of_two_members_are_the_named_members_in_order() {
    selects_the_named_members::<2>();
}

#[kani::proof]
#[kani::unwind(34)]
fn signers_of_three_members_are_the_named_members_in_order() {
    selects_the_named_members::<3>();
}

#[kani::proof]
#[kani::unwind(34)]
fn signers_of_four_members_are_the_named_members_in_order() {
    selects_the_named_members::<4>();
}

#[kani::proof]
#[kani::unwind(34)]
fn signers_of_five_members_are_the_named_members_in_order() {
    selects_the_named_members::<5>();
}

#[kani::proof]
#[kani::unwind(34)]
fn signers_of_six_members_are_the_named_members_in_order() {
    selects_the_named_members::<6>();
}

#[kani::proof]
#[kani::unwind(34)]
fn signers_of_seven_members_are_the_named_members_in_order() {
    selects_the_named_members::<7>();
}

#[kani::proof]
#[kani::unwind(34)]
fn signers_of_eight_members_are_the_named_members_in_order() {
    selects_the_named_members::<8>();
}

#[kani::proof]
#[kani::unwind(34)]
fn new_refuses_an_empty_member_list() {
    assert!(Committee::new(&[], kani::any(), kani::any()).is_err());
}

#[kani::proof]
#[kani::unwind(34)]
fn new_refuses_a_threshold_of_zero_or_above_the_member_count() {
    each_count!(any_count(), reaches_no_threshold);
}

#[kani::proof]
#[kani::unwind(34)]
fn new_refuses_duplicate_members() {
    each_count!(any_count(), repeats_a_member);
}

#[kani::proof]
#[kani::unwind(34)]
fn from_stored_accepts_exactly_what_new_accepts_and_builds_the_same_committee() {
    each_count!(any_count(), stored_matches_new);
}

#[kani::proof]
#[kani::unwind(34)]
fn from_stored_refuses_a_count_above_the_maximum() {
    let count: u8 = kani::any();
    kani::assume(usize::from(count) > MAX_MEMBERS);
    let stored: [[u8; 32]; MAX_MEMBERS] = distinct();
    assert!(Committee::from_stored(kani::any(), count, &stored, kani::any()).is_err());
}

#[kani::proof]
#[kani::unwind(34)]
fn from_stored_refuses_a_member_beyond_the_count() {
    each_count!(any_count(), refuses_a_named_padding);
}
