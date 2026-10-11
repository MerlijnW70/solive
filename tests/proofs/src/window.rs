use intent_core::nonce::{Window, WINDOW_BITS};

fn window() -> Window {
    Window {
        base: kani::any(),
        bits: kani::any(),
    }
}

#[kani::proof]
fn a_nonce_consumes_once_and_marks_only_itself() {
    let mut w = window();
    let before = w;
    let n: u64 = kani::any();
    let other: u64 = kani::any();
    kani::assume(other != n);
    match w.consume(n) {
        Ok(()) => {
            assert_eq!(before.is_used(n), Ok(false));
            assert_eq!(w.is_used(n), Ok(true));
            assert!(w.consume(n).is_err());
        }
        Err(_) => {
            assert_eq!(w, before);
            assert_ne!(before.is_used(n), Ok(false));
        }
    }
    assert_eq!(w.base, before.base);
    assert_eq!(w.is_used(other), before.is_used(other));
}

#[kani::proof]
fn advancing_forgets_nothing_still_in_the_window_and_burns_everything_below() {
    let mut w = window();
    let old = w;
    let new_base: u64 = kani::any();
    let n: u64 = kani::any();
    match w.advance(new_base) {
        Ok(()) => {
            assert!(new_base > old.base);
            assert_eq!(w.base, new_base);
            if n < new_base {
                assert_eq!(w.is_used(n), Ok(true));
            } else if n - new_base < WINDOW_BITS {
                let expected = if n - old.base < WINDOW_BITS {
                    old.is_used(n)
                } else {
                    Ok(false)
                };
                assert_eq!(w.is_used(n), expected);
            } else {
                assert!(w.is_used(n).is_err());
            }
        }
        Err(_) => {
            assert!(new_base <= old.base);
            assert_eq!(w, old);
        }
    }
}

#[kani::proof]
fn the_next_free_nonce_is_free_and_the_first_one() {
    let w = window();
    let m: u64 = kani::any();
    let in_window = m >= w.base && m - w.base < WINDOW_BITS;
    match w.next_free() {
        Some(n) => {
            assert_eq!(w.is_used(n), Ok(false));
            if m >= w.base && m < n {
                assert_eq!(w.is_used(m), Ok(true));
            }
        }
        None => {
            if in_window && w.bits == [u64::MAX; 4] {
                assert_eq!(w.is_used(m), Ok(true));
            }
            if w.bits != [u64::MAX; 4] {
                assert!(w.base.checked_add(WINDOW_BITS - 1).is_none());
            }
        }
    }
}
