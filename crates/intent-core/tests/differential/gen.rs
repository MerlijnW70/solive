use crate::pairs::{nums, Val};
use crate::rng::{to_i64, to_u64, Rng};
use intent_core::claim::{MAX_CLAIM_SECS, MAX_CLAIM_STAKE};
use intent_core::delivery::{
    BLOB_FIXED_LEN, BLOB_HEAD_LEN, BLOB_PER_RECIPIENT_LEN, BLOB_VERSION, FINGERPRINT_LEN,
    MAX_BLOB_RECIPIENTS, MAX_BLOB_URL, MAX_SPLIT_RECIPIENTS, REFUTE_WINDOW_SECS,
};
use intent_core::mandate::{lane_of, MAX_LANE_SERIAL};
use intent_core::nonce::Window;

pub fn mul_div_gen(r: &mut Rng) -> Vec<Val> {
    let a = r.u64();
    let b = r.u64();
    let p = u128::from(a).wrapping_mul(u128::from(b));
    let d = match r.below(6) {
        0 => r.pick(&[0, 1, 10_000], 1),
        1 => {
            let q = p.checked_div(u128::from(u64::MAX)).unwrap_or(0);
            to_u64(r.wobble(i128::try_from(q).unwrap_or(0), 2))
        }
        2 => a.checked_div(r.upto(9).saturating_add(1)).unwrap_or(1),
        3 => b.checked_div(r.upto(9).saturating_add(1)).unwrap_or(1),
        _ => r.u64(),
    };
    nums(&[a, b, d])
}

fn bps_args(r: &mut Rng, count: usize) -> Vec<Val> {
    let first = r.bps();
    let mut out = vec![Val::N(i128::from(first))];
    for _ in 1..count {
        let next = if r.one_in(4) {
            to_u64(r.wobble(i128::from(10_000u16.saturating_sub(first)), 1))
        } else {
            u64::from(r.bps())
        };
        out.push(Val::N(i128::from(next)));
    }
    out
}

pub fn split_fee_gen(r: &mut Rng) -> Vec<Val> {
    let mut out = nums(&[r.amount()]);
    out.extend(bps_args(r, 1));
    out
}

pub fn split_fees_gen(r: &mut Rng) -> Vec<Val> {
    let mut out = nums(&[r.amount()]);
    out.extend(bps_args(r, 3));
    out
}

pub fn release_settles_gen(r: &mut Rng) -> Vec<Val> {
    let amount = r.amount();
    let judge = match r.below(5) {
        0 => 0,
        1 => to_u64(r.wobble(i128::from(amount), 3)),
        2 => r.upto(amount),
        3 => amount.saturating_sub(r.below(20_000)),
        _ => r.u64(),
    };
    let mut out = nums(&[amount, judge]);
    out.extend(bps_args(r, 3));
    out
}

fn weights(r: &mut Rng) -> Vec<i128> {
    let len = match r.below(4) {
        0 => r.pick(&[0, 1, 2, 16, 17], 1),
        _ => r.upto(17),
    };
    if r.one_in(6) {
        return (0..len).map(|_| i128::from(r.bps())).collect();
    }
    let count = usize::try_from(len).unwrap_or(0);
    let mut ws = vec![0i128; count];
    let share = 10_000u64.checked_div(len).unwrap_or(0);
    for slot in ws.iter_mut() {
        *slot = i128::from(share);
    }
    let rest = 10_000u64.saturating_sub(share.saturating_mul(len));
    let at = usize::try_from(r.below(len)).unwrap_or(0);
    if let Some(slot) = ws.get_mut(at) {
        *slot = slot.saturating_add(i128::from(rest));
    }
    let moves = if r.one_in(3) { 0 } else { r.upto(8) };
    for _ in 0..moves {
        let from = usize::try_from(r.below(len)).unwrap_or(0);
        let to = usize::try_from(r.below(len)).unwrap_or(0);
        let have = ws.get(from).copied().unwrap_or(0);
        let take = i128::from(r.upto(to_u64(have)));
        if let Some(slot) = ws.get_mut(from) {
            *slot = slot.saturating_sub(take);
        }
        if let Some(slot) = ws.get_mut(to) {
            *slot = slot.saturating_add(take);
        }
    }
    if r.one_in(5) {
        let at = usize::try_from(r.below(len)).unwrap_or(0);
        let delta = if r.one_in(2) { 1 } else { -1 };
        if let Some(slot) = ws.get_mut(at) {
            *slot = slot.saturating_add(delta).clamp(0, 65_535);
        }
    }
    ws
}

pub fn split_n_gen(r: &mut Rng) -> Vec<Val> {
    vec![Val::N(i128::from(r.amount())), Val::L(weights(r))]
}

fn max_secs(r: &mut Rng) -> u64 {
    let max = u64::from(MAX_CLAIM_SECS);
    match r.below(4) {
        0 => r.pick(
            &[
                0,
                1,
                2,
                max.saturating_sub(1),
                max,
                max.saturating_add(1),
                u64::from(u32::MAX),
            ],
            1,
        ),
        1 => r.upto(u64::from(u32::MAX)),
        _ => r.upto(max.saturating_add(1)),
    }
}

fn stake(r: &mut Rng) -> u64 {
    match r.below(3) {
        0 => r.pick(
            &[
                0,
                1,
                MAX_CLAIM_STAKE - 1,
                MAX_CLAIM_STAKE,
                MAX_CLAIM_STAKE + 1,
                u64::MAX,
            ],
            0,
        ),
        1 => r.u64(),
        _ => r.upto(MAX_CLAIM_STAKE.saturating_add(1)),
    }
}

pub fn claim_terms_gen(r: &mut Rng) -> Vec<Val> {
    let m = max_secs(r);
    let st = stake(r);
    nums(&[m, st])
}

pub fn claim_until_gen(r: &mut Rng) -> Vec<Val> {
    let max = if r.one_in(8) {
        max_secs(r)
    } else {
        r.below(u64::from(MAX_CLAIM_SECS)).saturating_add(1)
    };
    let st = if r.one_in(8) {
        stake(r)
    } else {
        r.upto(MAX_CLAIM_STAKE)
    };
    let sec = match r.below(4) {
        0 => r.pick(&[0, 1, u64::from(u32::MAX)], 1),
        1 => to_u64(r.wobble(i128::from(max), 1)),
        _ => r.upto(max.saturating_add(1)),
    };
    let now = if r.one_in(4) {
        i128::from(i64::MAX)
            .saturating_sub(i128::from(sec))
            .saturating_add(r.wobble(0, 1))
    } else {
        i128::from(r.i64())
    };
    let end = i128::from(sec).saturating_add(now);
    let expires = match r.below(3) {
        0 => i128::from(r.i64()),
        _ => r.wobble(end, 2),
    };
    vec![
        Val::N(i128::from(max)),
        Val::N(i128::from(st)),
        Val::N(i128::from(to_i64(now))),
        Val::N(i128::from(sec)),
        Val::N(i128::from(to_i64(expires))),
    ]
}

pub fn board_gen(r: &mut Rng) -> Vec<Val> {
    let owner = r.below(4);
    let worker = if r.one_in(4) { 0 } else { r.below(4) };
    let now = r.i64();
    let until = match r.below(3) {
        0 => i128::from(r.i64()),
        _ => r.wobble(i128::from(now), 2),
    };
    vec![
        Val::N(i128::from(owner)),
        Val::N(i128::from(worker)),
        Val::N(i128::from(to_i64(until))),
        Val::N(i128::from(now)),
    ]
}

pub fn stake_on_release_gen(r: &mut Rng) -> Vec<Val> {
    let mut out = board_gen(r);
    let len = r.upto(3);
    out.push(Val::L((0..len).map(|_| i128::from(r.below(4))).collect()));
    out
}

pub fn stake_on_settle_gen(r: &mut Rng) -> Vec<Val> {
    let mut out = board_gen(r);
    out.push(Val::N(i128::from(r.below(2))));
    out
}

fn serial(r: &mut Rng) -> u64 {
    match r.below(3) {
        0 => r.pick(
            &[
                0,
                1,
                2,
                MAX_LANE_SERIAL - 1,
                MAX_LANE_SERIAL,
                MAX_LANE_SERIAL + 1,
                1 << 32,
                u64::MAX,
            ],
            1,
        ),
        1 => r.upto(MAX_LANE_SERIAL.saturating_add(1)),
        _ => r.u64(),
    }
}

pub fn lane_of_gen(r: &mut Rng) -> Vec<Val> {
    nums(&[serial(r)])
}

pub fn in_lane_gen(r: &mut Rng) -> Vec<Val> {
    let sr = serial(r);
    let near = to_u64(r.wobble(i128::from(sr), 1));
    let nonce = match (lane_of(near), r.below(4)) {
        (Some(lane), 0) => lane,
        (Some(lane), 1) => lane | 0xffff_ffff,
        (Some(lane), 2) => lane | r.below(1 << 32),
        (Some(lane), _) => {
            lane ^ 1u64
                .checked_shl(r.pick(&[31u32, 32, 62, 63], 63))
                .unwrap_or(0)
        }
        (None, _) => r.u64(),
    };
    nums(&[nonce, sr])
}

fn word(r: &mut Rng) -> u64 {
    match r.below(6) {
        0 | 1 => u64::MAX,
        2 => 0,
        3 => u64::MAX
            .checked_shr(u32::try_from(r.upto(64)).unwrap_or(0))
            .unwrap_or(0),
        4 => {
            u64::MAX
                ^ 1u64
                    .checked_shl(u32::try_from(r.below(64)).unwrap_or(0))
                    .unwrap_or(0)
        }
        _ => r.next(),
    }
}

pub fn next_free_gen(r: &mut Rng) -> Vec<Val> {
    let words = [word(r), word(r), word(r), word(r)];
    let window = Window {
        base: 0,
        bits: words,
    };
    let base = match (window.next_free(), r.below(3)) {
        (Some(offset), 0) => to_u64(r.wobble(i128::from(u64::MAX.saturating_sub(offset)), 1)),
        _ => r.u64(),
    };
    let mut out = nums(&[base]);
    out.extend(nums(&words));
    out
}

pub fn required_out_gen(r: &mut Rng) -> Vec<Val> {
    let kind = r.below(3);
    let a = if r.one_in(10) { 0 } else { r.amount() };
    let b = if r.one_in(10) { 0 } else { r.amount() };
    let (c, start, end) = if kind == 2 {
        let c = match r.below(4) {
            0 => to_u64(r.wobble(i128::from(b), 1)),
            1 => r.upto(b),
            _ => r.u64(),
        };
        let start = r.i64();
        let end = match r.below(3) {
            0 => r.wobble(i128::from(start), 2),
            1 => i128::from(r.i64()),
            _ => i128::from(start).saturating_add(i128::from(r.below(1 << 40))),
        };
        (c, start, to_i64(end))
    } else {
        (0, 0, 0)
    };
    let amount_in = match r.below(4) {
        0 => to_u64(r.wobble(i128::from(a), 1)),
        1 => r.upto(a),
        2 => r.pick(&[0, 1], 0),
        _ => r.u64(),
    };
    let now = match r.below(4) {
        0 => r.wobble(i128::from(start), 1),
        1 => r.wobble(i128::from(end), 1),
        2 => i128::from(start).saturating_add(
            i128::from(end)
                .saturating_sub(i128::from(start))
                .checked_div(2)
                .unwrap_or(0),
        ),
        _ => i128::from(r.i64()),
    };
    vec![
        Val::N(i128::from(kind)),
        Val::N(i128::from(a)),
        Val::N(i128::from(b)),
        Val::N(i128::from(c)),
        Val::N(i128::from(start)),
        Val::N(i128::from(end)),
        Val::N(i128::from(amount_in)),
        Val::N(i128::from(to_i64(now))),
    ]
}

fn byte(r: &mut Rng) -> i128 {
    match r.below(5) {
        0 => i128::from(r.pick(&[0u8, 1, 0x7f, 0x80, 0xff], 0)),
        _ => i128::from(r.below(256)),
    }
}

fn bytes(r: &mut Rng, count: u64) -> Vec<i128> {
    (0..count).map(|_| byte(r)).collect()
}

pub fn commitment_preimage_gen(r: &mut Rng) -> Vec<Val> {
    (0..4).map(|_| Val::N(byte(r))).collect()
}

pub fn fingerprint_preimage_gen(r: &mut Rng) -> Vec<Val> {
    vec![Val::N(byte(r))]
}

fn blob_url(r: &mut Rng) -> u64 {
    let max = u64::try_from(MAX_BLOB_URL).unwrap_or(0);
    match r.below(5) {
        0 => r.pick(
            &[
                0,
                1,
                max.saturating_sub(1),
                max,
                max.saturating_add(1),
                max.saturating_add(5),
                max.saturating_add(6),
            ],
            1,
        ),
        1 => r.upto(max.saturating_add(50)),
        _ => r.below(max).saturating_add(1),
    }
}

pub fn blob_head_gen(r: &mut Rng) -> Vec<Val> {
    if r.one_in(10) {
        let len = r.upto(20);
        return vec![Val::L(bytes(r, len))];
    }
    let most = u64::try_from(MAX_BLOB_RECIPIENTS).unwrap_or(0);
    let version = if r.one_in(10) {
        r.below(256)
    } else {
        u64::from(BLOB_VERSION)
    };
    let count = if r.one_in(6) {
        r.pick(&[0, most.saturating_add(1), 255], 0)
    } else {
        r.below(most).saturating_add(1)
    };
    let mask = if r.one_in(6) {
        r.below(256)
    } else {
        r.below(
            1u64.checked_shl(u32::try_from(count).unwrap_or(8))
                .unwrap_or(256)
                .min(256),
        )
    };
    let listed = count.min(most.saturating_add(1));
    let fixed = u64::try_from(BLOB_FIXED_LEN.saturating_sub(BLOB_HEAD_LEN)).unwrap_or(0);
    let per = u64::try_from(BLOB_PER_RECIPIENT_LEN.saturating_sub(FINGERPRINT_LEN)).unwrap_or(0);
    let rest = fixed
        .saturating_add(per.saturating_mul(listed))
        .saturating_add(blob_url(r));
    let fp_bytes = u64::try_from(FINGERPRINT_LEN).unwrap_or(0);
    let mut out = vec![i128::from(version), i128::from(count), i128::from(mask)];
    out.extend(bytes(r, listed.saturating_mul(fp_bytes)));
    out.extend(bytes(r, rest));
    match r.below(8) {
        0 => {
            let keep = usize::try_from(r.upto(u64::try_from(out.len()).unwrap_or(0))).unwrap_or(0);
            out.truncate(keep);
        }
        1 => {
            let extra = r.upto(10);
            out.extend(bytes(r, extra));
        }
        _ => {}
    }
    vec![Val::L(out)]
}

pub fn may_announce_gen(r: &mut Rng) -> Vec<Val> {
    let mut out = board_gen(r);
    let holder = match out.get(1) {
        Some(Val::N(w)) => *w,
        _ => 0,
    };
    let announcer = if r.one_in(2) {
        holder
    } else {
        i128::from(r.below(4))
    };
    out.push(Val::N(announcer));
    out
}

pub fn ann_state_gen(r: &mut Rng) -> Vec<Val> {
    let state = match r.below(3) {
        0 => r.pick(&[0, 1, 2, 3, 127, 128, 254, 255], 0),
        1 => r.below(2),
        _ => r.below(256),
    };
    nums(&[state])
}

fn refute_time(r: &mut Rng) -> i64 {
    let last = i128::from(i64::MAX).saturating_sub(i128::from(REFUTE_WINDOW_SECS));
    match r.below(4) {
        0 => to_i64(r.wobble(last, 2)),
        1 => to_i64(r.wobble(1_700_000_000, 100_000)),
        _ => r.i64(),
    }
}

pub fn closable_gen(r: &mut Rng) -> Vec<Val> {
    let state = r.below(2);
    let by_worker = r.below(2);
    let intent_open = r.below(2);
    let expires_at = refute_time(r);
    let paid_at = refute_time(r);
    let from = if state == 1 { paid_at } else { expires_at };
    let edge = i128::from(from).saturating_add(i128::from(REFUTE_WINDOW_SECS));
    let now = match r.below(4) {
        0 | 1 => to_i64(r.wobble(edge, 2)),
        2 => to_i64(r.wobble(i128::from(from), 2)),
        _ => r.i64(),
    };
    vec![
        Val::N(i128::from(state)),
        Val::N(i128::from(by_worker)),
        Val::N(i128::from(intent_open)),
        Val::N(i128::from(now)),
        Val::N(i128::from(expires_at)),
        Val::N(i128::from(paid_at)),
    ]
}

pub fn refutes_gen(r: &mut Rng) -> Vec<Val> {
    let paid = r.u64();
    let earlier = match r.below(4) {
        0 => to_u64(r.wobble(i128::from(paid), 1)),
        1 => r.upto(paid),
        2 => paid.saturating_sub(1),
        _ => r.u64(),
    };
    let worker = r.below(4);
    let len = r.upto(4);
    let payees = (0..len).map(|_| i128::from(r.below(4))).collect();
    vec![
        Val::N(i128::from(earlier)),
        Val::N(i128::from(paid)),
        Val::N(i128::from(worker)),
        Val::L(payees),
    ]
}

pub fn split_hash_preimage_gen(r: &mut Rng) -> Vec<Val> {
    let most = u64::try_from(MAX_SPLIT_RECIPIENTS).unwrap_or(0);
    let n = match r.below(4) {
        0 => r.pick(&[0, 1, most, most.saturating_add(1), 16], 1),
        _ => r.upto(most),
    };
    let weighted = match r.below(6) {
        0 => to_u64(r.wobble(i128::from(n), 1)),
        1 => r.upto(most.saturating_add(2)),
        _ => n,
    };
    let recipients = bytes(r, n);
    let weights = (0..weighted).map(|_| i128::from(r.bps())).collect();
    vec![Val::L(recipients), Val::L(weights)]
}

fn revision(r: &mut Rng) -> i128 {
    match r.below(3) {
        0 => i128::from(r.pick(&[0u32, 1, u32::MAX - 1, u32::MAX], 0)),
        1 => i128::from(r.below(1_000)),
        _ => i128::from(r.next().checked_shr(32).unwrap_or(0)),
    }
}

fn terms(r: &mut Rng) -> Vec<Val> {
    vec![
        Val::N(i128::from(r.amount())),
        Val::N(i128::from(r.u64())),
        Val::N(i128::from(r.u64())),
        Val::N(revision(r)),
        Val::N(i128::from(r.bps())),
    ]
}

fn opening(r: &mut Rng) -> Vec<Val> {
    vec![
        Val::N(byte(r)),
        Val::N(i128::from(r.u64())),
        Val::N(byte(r)),
        Val::N(byte(r)),
    ]
}

pub fn attested_delivery_preimage_gen(r: &mut Rng) -> Vec<Val> {
    let mut out: Vec<Val> = (0..4).map(|_| Val::N(byte(r))).collect();
    out.extend(terms(r));
    out.extend([Val::N(byte(r)), Val::N(byte(r))]);
    out.extend(opening(r));
    out
}

pub fn attested_split_delivery_preimage_gen(r: &mut Rng) -> Vec<Val> {
    let mut out: Vec<Val> = (0..3).map(|_| Val::N(byte(r))).collect();
    out.extend(terms(r));
    out.extend([Val::N(byte(r)), Val::N(byte(r)), Val::N(byte(r))]);
    out.extend(opening(r));
    out
}
