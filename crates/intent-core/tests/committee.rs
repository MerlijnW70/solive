use intent_core::committee::{
    Committee, COMMITTEE_PREIMAGE_LEN, COMMITTEE_TAG, MAX_MEMBERS, MAX_THRESHOLD,
};
use intent_core::Error;
use proptest::prelude::*;

fn key(n: u8) -> [u8; 32] {
    let mut k = [0; 32];
    if let Some(first) = k.first_mut() {
        *first = n;
    }
    k
}

fn keys(range: std::ops::RangeInclusive<u8>) -> Vec<[u8; 32]> {
    range.map(key).collect()
}

const FEE: [u8; 32] = [9; 32];

#[test]
fn a_committee_is_sorted_named_members_and_a_reachable_threshold() -> Result<(), Error> {
    let members = keys(1..=3);
    let committee = Committee::new(&members, 2, FEE)?;
    assert_eq!(committee.members(), &members[..]);
    assert_eq!(committee.threshold(), 2);
    assert_eq!(committee.fee_wallet(), FEE);
    assert!(Committee::new(&keys(1..=8), MAX_THRESHOLD, FEE).is_ok());
    assert!(Committee::new(&keys(1..=1), 1, FEE).is_ok());
    Ok(())
}

#[test]
fn anything_else_is_refused() {
    for (members, threshold, fee) in [
        (vec![], 1, FEE),
        (keys(1..=9), 1, FEE),
        (keys(1..=2), 0, FEE),
        (keys(1..=2), 3, FEE),
        (keys(1..=8), MAX_THRESHOLD + 1, FEE),
        (vec![key(2), key(1)], 1, FEE),
        (vec![key(1), key(1)], 1, FEE),
        (vec![[0; 32], key(1)], 1, FEE),
        (keys(1..=2), 1, [0; 32]),
    ] {
        assert_eq!(
            Committee::new(&members, threshold, fee),
            Err(Error::CommitteeInvalid),
            "{members:?} {threshold}"
        );
    }
}

#[test]
fn the_preimage_lays_out_every_field_and_pads_the_members() -> Result<(), Error> {
    let preimage = Committee::new(&keys(1..=2), 2, FEE)?.preimage();
    let padding_end = 18 + 32 * MAX_MEMBERS;
    assert_eq!(preimage.len(), COMMITTEE_PREIMAGE_LEN);
    assert_eq!(preimage.get(..16), Some(&COMMITTEE_TAG[..]));
    assert_eq!(preimage.get(16..18), Some(&[2, 2][..]));
    assert_eq!(preimage.get(18..50), Some(&key(1)[..]));
    assert_eq!(preimage.get(50..82), Some(&key(2)[..]));
    assert!(preimage
        .get(82..padding_end)
        .is_some_and(|rest| rest.iter().all(|b| *b == 0)));
    assert_eq!(preimage.get(padding_end..), Some(&FEE[..]));
    Ok(())
}

#[test]
fn a_stored_committee_reads_back_only_when_it_is_valid() -> Result<(), Error> {
    let committee = Committee::new(&keys(1..=2), 1, FEE)?;
    let mut stored = [[0; 32]; MAX_MEMBERS];
    for (slot, member) in stored.iter_mut().zip(keys(1..=2)) {
        *slot = member;
    }
    assert_eq!(Committee::from_stored(1, 2, &stored, FEE), Ok(committee));
    let mut padded = stored;
    if let Some(slot) = padded.get_mut(5) {
        *slot = key(7);
    }
    assert_eq!(
        Committee::from_stored(1, 2, &padded, FEE),
        Err(Error::CommitteeInvalid)
    );
    assert_eq!(
        Committee::from_stored(1, 9, &stored, FEE),
        Err(Error::CommitteeInvalid)
    );
    assert_eq!(
        Committee::from_stored(3, 2, &stored, FEE),
        Err(Error::CommitteeInvalid)
    );
    Ok(())
}

#[test]
fn signers_are_the_masked_members_in_order_and_at_least_the_threshold() -> Result<(), Error> {
    let committee = Committee::new(&keys(1..=3), 2, FEE)?;
    assert_eq!(committee.signers(0b101)?.keys(), &[key(1), key(3)]);
    assert_eq!(committee.signers(0b111)?.keys(), &keys(1..=3)[..]);
    for refused in [0b001, 0, 0b1011, 0b1000_0011] {
        assert_eq!(
            committee.signers(refused),
            Err(Error::CommitteeSigners),
            "{refused:#b}"
        );
    }
    let eight = Committee::new(&keys(1..=8), MAX_THRESHOLD, FEE)?;
    assert_eq!(eight.signers(0xff)?.keys(), &keys(1..=8)[..]);
    assert_eq!(
        eight.signers(0b1000_0101)?.keys(),
        &[key(1), key(3), key(8)]
    );
    assert_eq!(eight.signers(0b11), Err(Error::CommitteeSigners));
    Ok(())
}

fn committee_strategy() -> impl Strategy<Value = (Vec<[u8; 32]>, u8)> {
    proptest::collection::btree_set(1u8..=255, 1..=MAX_MEMBERS).prop_flat_map(|set| {
        let members: Vec<[u8; 32]> = set.into_iter().map(key).collect();
        let count = u8::try_from(members.len()).unwrap_or(1);
        (Just(members), 1..=count.min(MAX_THRESHOLD))
    })
}

proptest! {
    #[test]
    fn signers_follow_the_mask_exactly(
        (members, threshold) in committee_strategy(),
        mask in any::<u8>(),
    ) {
        let committee = Committee::new(&members, threshold, FEE)
            .map_err(|e| TestCaseError::fail(format!("{e:?}")))?;
        let width = u32::try_from(members.len()).unwrap_or(8);
        let within = mask.checked_shr(width).unwrap_or(0) == 0;
        let enough = mask.count_ones() >= u32::from(threshold);
        let expected: Vec<[u8; 32]> = (0u32..)
            .zip(&members)
            .filter(|(bit, _)| mask & 1u8.checked_shl(*bit).unwrap_or(0) != 0)
            .map(|(_, member)| *member)
            .collect();
        match committee.signers(mask) {
            Ok(signers) => {
                prop_assert!(within && enough);
                prop_assert_eq!(signers.keys(), &expected[..]);
            }
            Err(error) => {
                prop_assert_eq!(error, Error::CommitteeSigners);
                prop_assert!(!(within && enough));
            }
        }
    }

    #[test]
    fn different_committees_never_share_a_preimage(
        (a, ta) in committee_strategy(),
        (b, tb) in committee_strategy(),
        fee_a in 1u8..,
        fee_b in 1u8..,
    ) {
        let left = Committee::new(&a, ta, [fee_a; 32])
            .map_err(|e| TestCaseError::fail(format!("{e:?}")))?;
        let right = Committee::new(&b, tb, [fee_b; 32])
            .map_err(|e| TestCaseError::fail(format!("{e:?}")))?;
        prop_assert_eq!(left.preimage() == right.preimage(), left == right);
    }
}
