use intent_core::mandate::MANDATE_NONCE_BIT;
use intent_core::nonce::{
    epoch_jump_allowed, nonce_jump_allowed, Window, MAX_EPOCH_JUMP, MAX_NONCE_JUMP, NONCE_CEILING,
    WINDOW_BITS,
};
use intent_core::Error;
use proptest::prelude::*;

fn window(base: u64) -> Window {
    Window { base, bits: [0; 4] }
}

#[test]
fn window_spans_256_nonces() {
    assert_eq!(WINDOW_BITS, 256);
}

#[test]
fn one_advance_moves_the_nonce_base_at_most_two_to_the_32_and_never_into_agent_lanes() {
    assert_eq!(MAX_NONCE_JUMP, 1 << 32);
    assert_eq!(NONCE_CEILING, MANDATE_NONCE_BIT - WINDOW_BITS);
    assert!(nonce_jump_allowed(0, MAX_NONCE_JUMP));
    assert!(!nonce_jump_allowed(0, MAX_NONCE_JUMP + 1));
    assert!(nonce_jump_allowed(7, 7 + MAX_NONCE_JUMP));
    assert!(!nonce_jump_allowed(7, 8 + MAX_NONCE_JUMP));
    assert!(nonce_jump_allowed(NONCE_CEILING - 1, NONCE_CEILING));
    assert!(!nonce_jump_allowed(NONCE_CEILING - 1, NONCE_CEILING + 1));
    assert!(!nonce_jump_allowed(5, 4));
    assert!(!nonce_jump_allowed(0, u64::MAX));
}

#[test]
fn one_advance_moves_the_epoch_at_most_two_to_the_48() {
    assert_eq!(MAX_EPOCH_JUMP, 1 << 48);
    assert!(epoch_jump_allowed(0, MAX_EPOCH_JUMP));
    assert!(!epoch_jump_allowed(0, MAX_EPOCH_JUMP + 1));
    assert!(epoch_jump_allowed(u64::MAX - MAX_EPOCH_JUMP, u64::MAX));
    assert!(!epoch_jump_allowed(9, 8));
    assert!(!epoch_jump_allowed(0, u64::MAX));
}

#[test]
fn consume_sets_little_endian_bit_per_word() -> Result<(), Error> {
    let mut w = window(1_000);
    w.consume(1_000)?;
    w.consume(1_001)?;
    w.consume(1_064)?;
    w.consume(1_191)?;
    w.consume(1_255)?;
    assert_eq!(w.bits, [0b11, 1, 1 << 63, 1 << 63]);
    assert_eq!(w.base, 1_000);
    Ok(())
}

#[test]
fn consume_rejects_reuse_below_base_and_beyond_window() -> Result<(), Error> {
    let mut w = window(1_000);
    w.consume(1_100)?;
    assert_eq!(w.consume(1_100), Err(Error::NonceUsed));
    assert_eq!(w.consume(999), Err(Error::NonceUsed));
    assert_eq!(w.consume(0), Err(Error::NonceUsed));
    assert_eq!(w.consume(1_256), Err(Error::NonceOutOfWindow));
    assert_eq!(w.consume(u64::MAX), Err(Error::NonceOutOfWindow));
    assert_eq!(w.bits, [0, 1 << 36, 0, 0]);
    Ok(())
}

#[test]
fn is_used_reports_bits_below_base_and_window_edges() -> Result<(), Error> {
    let mut w = window(64);
    for n in [64, 129, 200, 319] {
        w.consume(n)?;
    }
    assert_eq!(w.is_used(0), Ok(true));
    assert_eq!(w.is_used(63), Ok(true));
    for n in [64, 129, 200, 319] {
        assert_eq!(w.is_used(n), Ok(true));
    }
    for n in [65, 128, 130, 199, 201, 318] {
        assert_eq!(w.is_used(n), Ok(false));
    }
    assert_eq!(w.is_used(320), Err(Error::NonceOutOfWindow));
    Ok(())
}

#[test]
fn advance_shifts_bits_toward_new_base() -> Result<(), Error> {
    let mut w = Window {
        base: 0,
        bits: [0x8000_0000_0000_0003, 0x5, 0x0, 0x8000_0000_0000_0001],
    };
    w.advance(1)?;
    assert_eq!(
        w.bits,
        [
            0xc000_0000_0000_0001,
            0x2,
            0x8000_0000_0000_0000,
            0x4000_0000_0000_0000
        ]
    );
    assert_eq!(w.base, 1);
    w.advance(65)?;
    assert_eq!(
        w.bits,
        [0x2, 0x8000_0000_0000_0000, 0x4000_0000_0000_0000, 0]
    );
    w.advance(130)?;
    assert_eq!(w.bits, [0x4000_0000_0000_0000, 0x2000_0000_0000_0000, 0, 0]);
    Ok(())
}

#[test]
fn advance_by_whole_window_or_more_clears_everything() -> Result<(), Error> {
    for delta in [256u64, 257, 10_000, u64::MAX - 7] {
        let mut w = Window {
            base: 7,
            bits: [u64::MAX; 4],
        };
        w.advance(7u64.wrapping_add(delta))?;
        assert_eq!(w.bits, [0; 4]);
    }
    let mut w = Window {
        base: 0,
        bits: [u64::MAX; 4],
    };
    w.advance(255)?;
    assert_eq!(w.bits, [1 << 0, 0, 0, 0]);
    Ok(())
}

#[test]
fn advance_only_moves_forward() {
    let mut w = window(50);
    assert_eq!(w.advance(50), Err(Error::NonceRegression));
    assert_eq!(w.advance(49), Err(Error::NonceRegression));
    assert_eq!(w, window(50));
}

#[test]
fn next_free_finds_lowest_unused_nonce() -> Result<(), Error> {
    let mut w = window(10);
    assert_eq!(w.next_free(), Some(10));
    w.consume(10)?;
    w.consume(11)?;
    w.consume(13)?;
    assert_eq!(w.next_free(), Some(12));
    let full = Window {
        base: 10,
        bits: [u64::MAX, u64::MAX, 0b0111, 0],
    };
    assert_eq!(full.next_free(), Some(10 + 128 + 3));
    let all = Window {
        base: 10,
        bits: [u64::MAX; 4],
    };
    assert_eq!(all.next_free(), None);
    Ok(())
}

#[test]
fn next_free_never_overflows_nonce_space() {
    let w = Window {
        base: u64::MAX - 3,
        bits: [0b1111, 0, 0, 0],
    };
    assert_eq!(w.next_free(), None);
    let v = Window {
        base: u64::MAX - 3,
        bits: [0b0111, 0, 0, 0],
    };
    assert_eq!(v.next_free(), Some(u64::MAX));
}

#[derive(Debug, Clone)]
enum Op {
    Consume(u16),
    Advance(u16),
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        (0u16..320).prop_map(Op::Consume),
        (0u16..300).prop_map(Op::Advance),
    ]
}

struct Model {
    base: u64,
    used: Vec<u64>,
}

impl Model {
    fn is_used(&self, n: u64) -> bool {
        n < self.base || self.used.contains(&n)
    }

    fn consume(&mut self, n: u64) -> Result<(), Error> {
        if self.is_used(n) {
            Err(Error::NonceUsed)
        } else if n >= self.base.saturating_add(WINDOW_BITS) {
            Err(Error::NonceOutOfWindow)
        } else {
            self.used.push(n);
            Ok(())
        }
    }

    fn advance(&mut self, to: u64) -> Result<(), Error> {
        if to <= self.base {
            return Err(Error::NonceRegression);
        }
        self.base = to;
        self.used.retain(|n| *n >= to);
        Ok(())
    }

    fn next_free(&self) -> Option<u64> {
        (self.base..self.base.saturating_add(WINDOW_BITS)).find(|n| !self.is_used(*n))
    }
}

proptest! {
    #[test]
    fn window_matches_set_model(
        start in prop_oneof![
            0u64..1_000,
            NONCE_CEILING.saturating_sub(600)..NONCE_CEILING,
            u64::MAX.saturating_sub(600)..u64::MAX,
        ],
        ops in prop::collection::vec(op(), 1..64),
    ) {
        let mut w = window(start);
        let mut m = Model { base: start, used: Vec::new() };
        for op in ops {
            match op {
                Op::Consume(off) => {
                    let n = m.base.saturating_add(u64::from(off)).saturating_sub(32);
                    prop_assert_eq!(w.consume(n), m.consume(n));
                }
                Op::Advance(off) => {
                    let to = m.base.saturating_add(u64::from(off)).saturating_sub(8);
                    prop_assert_eq!(w.advance(to), m.advance(to));
                }
            }
            prop_assert_eq!(w.base, m.base);
            prop_assert_eq!(w.next_free(), m.next_free());
            for probe in m.base.saturating_sub(4)..m.base.saturating_add(WINDOW_BITS) {
                prop_assert_eq!(w.is_used(probe), Ok(m.is_used(probe)));
            }
        }
    }
}

proptest! {
    #[test]
    fn no_allowed_advance_ever_reaches_the_agent_lanes(base in 0u64..NONCE_CEILING, to in any::<u64>()) {
        if nonce_jump_allowed(base, to) {
            let mut w = window(base);
            prop_assert!(w.advance(to).is_ok() || to == base);
            prop_assert!(to <= NONCE_CEILING);
            let top = to.checked_add(WINDOW_BITS.saturating_sub(1));
            prop_assert!(top.is_some_and(|t| t & MANDATE_NONCE_BIT == 0));
            prop_assert!(w.next_free().is_none_or(|n| n & MANDATE_NONCE_BIT == 0));
        }
    }
}
