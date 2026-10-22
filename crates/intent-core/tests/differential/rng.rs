pub struct Rng(u64);

pub const U64_EDGES: &[u64] = &[
    0,
    1,
    2,
    3,
    9_999,
    10_000,
    10_001,
    u32::MAX as u64,
    1 << 32,
    (1 << 63) - 1,
    1 << 63,
    u64::MAX - 10_000,
    u64::MAX - 2,
    u64::MAX - 1,
    u64::MAX,
];

pub const I64_EDGES: &[i64] = &[
    i64::MIN,
    i64::MIN + 1,
    -1,
    0,
    1,
    1_700_000_000,
    i64::MAX - 604_800,
    i64::MAX - 1,
    i64::MAX,
];

pub const BPS_EDGES: &[u16] = &[
    0, 1, 2, 30, 100, 300, 5_000, 9_999, 10_000, 10_001, 10_002, 65_534, 65_535,
];

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }

    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    pub fn below(&mut self, n: u64) -> u64 {
        self.next().checked_rem(n).unwrap_or(0)
    }

    pub fn upto(&mut self, n: u64) -> u64 {
        match n.checked_add(1) {
            Some(m) => self.below(m),
            None => self.next(),
        }
    }

    pub fn one_in(&mut self, n: u64) -> bool {
        self.below(n) == 0
    }

    pub fn pick<T: Copy>(&mut self, xs: &[T], fallback: T) -> T {
        let at = usize::try_from(self.below(u64::try_from(xs.len()).unwrap_or(0))).unwrap_or(0);
        xs.get(at).copied().unwrap_or(fallback)
    }

    pub fn wobble(&mut self, center: i128, spread: u64) -> i128 {
        let span = i128::from(spread);
        let step = i128::from(self.upto(spread.saturating_mul(2)));
        center.saturating_add(step).saturating_sub(span)
    }

    pub fn u64(&mut self) -> u64 {
        match self.below(6) {
            0 | 1 => self.pick(U64_EDGES, 0),
            2 => self.below(40),
            3 => self.below(1_000_000),
            4 => self
                .next()
                .checked_shr(u32::try_from(self.below(64)).unwrap_or(0))
                .unwrap_or(0),
            _ => self.next(),
        }
    }

    pub fn amount(&mut self) -> u64 {
        match self.below(5) {
            0 => {
                let k = self.below(1 << 40);
                let base = k.saturating_mul(10_000);
                to_u64(self.wobble(i128::from(base), 1))
            }
            _ => self.u64(),
        }
    }

    pub fn i64(&mut self) -> i64 {
        match self.below(4) {
            0 => self.pick(I64_EDGES, 0),
            1 => i64::try_from(self.wobble(1_700_000_000, 1_000_000)).unwrap_or(0),
            2 => self.next().cast_signed(),
            _ => i64::try_from(self.wobble(0, 1_000)).unwrap_or(0),
        }
    }

    pub fn bps(&mut self) -> u16 {
        match self.below(5) {
            0 | 1 => self.pick(BPS_EDGES, 0),
            2 => u16::try_from(self.below(10_001)).unwrap_or(0),
            3 => u16::try_from(self.below(200)).unwrap_or(0),
            _ => u16::try_from(self.below(65_536)).unwrap_or(0),
        }
    }
}

pub fn to_u64(v: i128) -> u64 {
    u64::try_from(v.clamp(0, i128::from(u64::MAX))).unwrap_or(0)
}

pub fn to_i64(v: i128) -> i64 {
    i64::try_from(v.clamp(i128::from(i64::MIN), i128::from(i64::MAX))).unwrap_or(0)
}
