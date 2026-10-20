#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    PerOrder,
    Window,
    Total,
    Overflow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub max_per_order: u64,
    pub window_cap: u64,
    pub window_secs: u32,
    pub total_limit: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Usage {
    pub window_start: i64,
    pub window_used: u64,
    pub outstanding: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Returned {
    pub counted: u64,
    pub capped: u64,
    pub outstanding: u64,
}

pub fn charge(limits: Limits, usage: Usage, amount: u64, now: i64) -> Result<Usage, Refusal> {
    if amount > limits.max_per_order {
        return Err(Refusal::PerOrder);
    }
    let ends = usage
        .window_start
        .checked_add(i64::from(limits.window_secs))
        .ok_or(Refusal::Overflow)?;
    let (window_start, window_used) = if now >= ends {
        (now, 0)
    } else {
        (usage.window_start, usage.window_used)
    };
    let used = window_used.checked_add(amount).ok_or(Refusal::Overflow)?;
    if used > limits.window_cap {
        return Err(Refusal::Window);
    }
    let outstanding = usage
        .outstanding
        .checked_add(amount)
        .ok_or(Refusal::Overflow)?;
    if limits.total_limit != 0 && outstanding > limits.total_limit {
        return Err(Refusal::Total);
    }
    Ok(Usage {
        window_start,
        window_used: used,
        outstanding,
    })
}

pub fn take_back(capped: u64, left: u64) -> (u64, u64) {
    let counted = left.min(capped);
    (counted, capped.saturating_sub(counted))
}

pub fn give_back(outstanding: u64, capped: u64, left: u64) -> Result<Returned, Refusal> {
    let (counted, capped) = take_back(capped, left);
    let outstanding = outstanding.checked_sub(counted).ok_or(Refusal::Overflow)?;
    Ok(Returned {
        counted,
        capped,
        outstanding,
    })
}

pub fn refund_outstanding(
    outstanding: u64,
    counted: u64,
    cap_created_at: i64,
    intent_created_at: i64,
) -> u64 {
    if cap_created_at <= intent_created_at {
        outstanding.saturating_sub(counted)
    } else {
        outstanding
    }
}
