use intent_core::claim::Line;

const STEPS: usize = 4;
const LONGEST: u32 = 4;

#[kani::proof]
#[kani::unwind(5)]
fn joining_and_passing_never_skip_or_repeat_a_place() {
    let mut line = Line {
        head: kani::any(),
        tail: kani::any(),
    };
    kani::assume(line.head <= line.tail);
    let mut joined = u64::from(line.tail - line.head);
    let mut served = 0u64;
    for _ in 0..STEPS {
        let before = line;
        if kani::any() {
            match line.join() {
                Ok(seq) => {
                    assert_eq!(seq, before.tail);
                    assert_eq!(line.head, before.head);
                    assert_eq!(u64::from(line.tail), u64::from(before.tail) + 1);
                    joined += 1;
                }
                Err(_) => {
                    assert_eq!(line, before);
                    assert_eq!(before.tail, u32::MAX);
                }
            }
        } else {
            match line.pass() {
                Some(seq) => {
                    assert_eq!(seq, before.head);
                    assert!(seq < before.tail);
                    assert_eq!(line.tail, before.tail);
                    assert_eq!(u64::from(line.head), u64::from(before.head) + 1);
                    served += 1;
                }
                None => {
                    assert_eq!(line, before);
                    assert!(before.is_empty());
                }
            }
        }
        assert!(line.head <= line.tail);
        assert_eq!(u64::from(line.waiting()), joined - served);
    }
}

#[kani::proof]
#[kani::unwind(6)]
fn serving_hands_out_the_first_present_place_and_passes_only_those_before_it() {
    let head: u32 = kani::any();
    let len: u32 = kani::any();
    kani::assume(len <= LONGEST);
    kani::assume(head.checked_add(len).is_some());
    let tail = head + len;
    let present: [bool; LONGEST as usize] = kani::any();
    let mut line = Line { head, tail };
    let mut next = head;
    let got = line.serve(|seq| {
        assert_eq!(seq, next);
        assert!(seq < tail);
        next += 1;
        present[(seq - head) as usize]
    });
    let first = (0..len).find(|&i| present[i as usize]);
    match first {
        Some(i) => {
            assert_eq!(got, Some(head + i));
            assert_eq!(line.head, head + i + 1);
        }
        None => {
            assert_eq!(got, None);
            assert_eq!(line.head, tail);
        }
    }
    assert_eq!(line.tail, tail);
    assert!(line.head <= line.tail);
}
