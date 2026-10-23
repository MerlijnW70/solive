use intent_core::roster::{admits, extend};
use intent_core::Error;

const ROOM: usize = 3;

#[kani::proof]
#[kani::unwind(5)]
fn a_list_admits_only_a_listed_worker_and_only_once_complete() {
    let workers: [u8; ROOM] = kani::any();
    let count: u8 = kani::any();
    let size: u8 = kani::any();
    kani::assume(usize::from(size) <= ROOM);
    let worker: u8 = kani::any();
    match admits(&workers, count, size, &worker) {
        Ok(()) => {
            assert_eq!(count, size);
            assert!(workers[..usize::from(count)].contains(&worker));
        }
        Err(Error::ClaimListIncomplete) => assert_ne!(count, size),
        Err(Error::NotListed) => {
            assert_eq!(count, size);
            assert!(!workers[..usize::from(count)].contains(&worker));
        }
        Err(_) => panic!(),
    }
}

#[kani::proof]
#[kani::unwind(5)]
fn extending_keeps_the_listed_appends_in_order_and_never_passes_the_size() {
    let mut workers: [u8; ROOM] = kani::any();
    let before = workers;
    let count: u8 = kani::any();
    let size: u8 = kani::any();
    let len: usize = kani::any();
    kani::assume(len <= ROOM);
    let added: [u8; ROOM] = kani::any();
    let added = &added[..len];
    match extend(&mut workers, count, size, added) {
        Ok(end) => {
            let start = usize::from(count);
            assert!(size >= 1 && usize::from(size) <= ROOM);
            assert_eq!(usize::from(end), start + len);
            assert!(end <= size);
            assert_eq!(workers[..start], before[..start]);
            assert_eq!(&workers[start..usize::from(end)], added);
            assert_eq!(workers[usize::from(end)..], before[usize::from(end)..]);
            for (i, worker) in added.iter().enumerate() {
                assert_ne!(*worker, 0);
                assert!(!before[..start].contains(worker));
                assert!(!added[..i].contains(worker));
            }
        }
        Err(_) => assert_eq!(workers, before),
    }
}

#[kani::proof]
#[kani::unwind(5)]
fn a_list_built_by_extending_never_repeats_or_holds_the_empty_key() {
    let mut workers = [0u8; ROOM];
    let size: u8 = kani::any();
    let first: [u8; ROOM] = kani::any();
    let second: [u8; ROOM] = kani::any();
    let a: usize = kani::any();
    let b: usize = kani::any();
    kani::assume(a <= ROOM && b <= ROOM);
    let Ok(count) = extend(&mut workers, 0, size, &first[..a]) else {
        return;
    };
    let count = extend(&mut workers, count, size, &second[..b]).unwrap_or(count);
    let listed = &workers[..usize::from(count)];
    for (i, worker) in listed.iter().enumerate() {
        assert_ne!(*worker, 0);
        assert!(!listed[..i].contains(worker));
    }
}
