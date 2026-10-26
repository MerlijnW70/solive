pub fn after(at: i64, secs: i64) -> i128 {
    i128::from(at).wrapping_add(i128::from(secs))
}

pub fn elapsed(now: i64, from: i64, secs: i64) -> bool {
    i128::from(now) >= after(from, secs)
}
