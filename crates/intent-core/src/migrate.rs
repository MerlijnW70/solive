pub fn top_up(lamports: u64, held: u64, from_min: u64, to_min: u64) -> u64 {
    let grown = lamports.saturating_add(to_min.saturating_sub(from_min));
    let target = grown.max(to_min.saturating_add(held));
    target.saturating_sub(lamports)
}
