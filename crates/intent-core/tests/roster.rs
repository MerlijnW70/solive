use intent_core::roster::{admits, check_size, extend, Key, MAX_CLAIMANTS};
use intent_core::Error;

fn key(n: u8) -> Key {
    [n; 32]
}

#[test]
fn a_size_is_one_to_thirty_two_and_fits_the_room() {
    assert_eq!(MAX_CLAIMANTS, 32);
    assert_eq!(check_size(1, MAX_CLAIMANTS), Ok(()));
    assert_eq!(check_size(32, MAX_CLAIMANTS), Ok(()));
    for (size, room) in [(0, MAX_CLAIMANTS), (33, 64), (4, 3)] {
        assert_eq!(
            check_size(size, room),
            Err(Error::ClaimListInvalid),
            "{size} {room}"
        );
    }
}

#[test]
fn a_list_fills_in_parts_and_admits_only_its_workers_once_complete() -> Result<(), Error> {
    let mut workers = [Key::default(); MAX_CLAIMANTS];
    let count = extend(&mut workers, 0, 3, &[key(1), key(2)])?;
    assert_eq!(count, 2);
    assert_eq!(
        admits(&workers, count, 3, &key(1)),
        Err(Error::ClaimListIncomplete)
    );
    let count = extend(&mut workers, count, 3, &[key(3)])?;
    assert_eq!(count, 3);
    for n in 1..=3 {
        assert_eq!(admits(&workers, count, 3, &key(n)), Ok(()));
    }
    assert_eq!(admits(&workers, count, 3, &key(4)), Err(Error::NotListed));
    assert_eq!(
        admits(&workers, count, 3, &Key::default()),
        Err(Error::NotListed)
    );
    assert_eq!(
        extend(&mut workers, count, 3, &[key(4)]),
        Err(Error::ClaimListInvalid)
    );
    Ok(())
}

#[test]
fn repeats_the_empty_key_and_overfills_are_refused_and_change_nothing() -> Result<(), Error> {
    let mut workers = [Key::default(); MAX_CLAIMANTS];
    let count = extend(&mut workers, 0, 4, &[key(1)])?;
    let before = workers;
    let refused: [&[Key]; 4] = [
        &[key(1)],
        &[key(2), key(2)],
        &[Key::default()],
        &[key(2), key(3), key(4), key(5)],
    ];
    for added in refused {
        assert_eq!(
            extend(&mut workers, count, 4, added),
            Err(Error::ClaimListInvalid)
        );
        assert_eq!(workers, before);
    }
    Ok(())
}
