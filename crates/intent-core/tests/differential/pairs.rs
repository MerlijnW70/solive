use crate::gen::{
    ann_state_gen, attested_delivery_preimage_gen, attested_split_delivery_preimage_gen,
    blob_head_gen, board_gen, claim_terms_gen, claim_until_gen, closable_gen,
    commitment_preimage_gen, fingerprint_preimage_gen, in_lane_gen, lane_of_gen, may_announce_gen,
    mul_div_gen, next_free_gen, refutes_gen, release_settles_gen, required_out_gen, split_fee_gen,
    split_fees_gen, split_hash_preimage_gen, split_n_gen, stake_on_release_gen,
    stake_on_settle_gen,
};
use crate::rng::{to_i64, to_u64, Rng};
use intent_core::bounty::split_n;
use intent_core::claim::{
    stake_on_cancel, stake_on_release, stake_on_settle, Slot, StakeTo, Terms,
};
use intent_core::delivery::{
    blob_head, closable, commitment_preimage, fingerprint_preimage, may_announce, refutes,
    split_hash_preimage, AnnState,
};
use intent_core::fee::{release_settles, split_fee, split_fees};
use intent_core::kinds::{dutch_auction, limit_order, swap_exact_in, Intent};
use intent_core::mandate::{in_lane, lane_of};
use intent_core::math::{mul_div_ceil, mul_div_floor};
use intent_core::nonce::Window;
use intent_core::sig::{AttestedDelivery, AttestedSplitDelivery};
use intent_core::Error;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Val {
    N(i128),
    L(Vec<i128>),
}

pub struct Pair {
    pub name: &'static str,
    pub gen: fn(&mut Rng) -> Vec<Val>,
    pub rust: fn(&[Val]) -> String,
    pub same_refusal: &'static [(&'static str, &'static str)],
}

fn n(args: &[Val], i: usize) -> i128 {
    match args.get(i) {
        Some(Val::N(v)) => *v,
        _ => 0,
    }
}

fn l(args: &[Val], i: usize) -> Vec<i128> {
    match args.get(i) {
        Some(Val::L(v)) => v.clone(),
        _ => Vec::new(),
    }
}

fn u(args: &[Val], i: usize) -> u64 {
    to_u64(n(args, i))
}

fn s(args: &[Val], i: usize) -> i64 {
    to_i64(n(args, i))
}

fn w(v: i128) -> u16 {
    u16::try_from(v).unwrap_or(0)
}

fn secs(v: i128) -> u32 {
    u32::try_from(v).unwrap_or(0)
}

pub fn nums(xs: &[u64]) -> Vec<Val> {
    xs.iter().map(|x| Val::N(i128::from(*x))).collect()
}

pub fn key(index: i128) -> [u8; 32] {
    [u8::try_from(index).unwrap_or(0); 32]
}

fn outcome<T>(r: Result<T, Error>, show: impl FnOnce(T) -> String) -> String {
    match r {
        Ok(v) => format!("ok {}", show(v)),
        Err(e) => format!("err {e:?}"),
    }
}

fn or_none(v: Option<u64>) -> String {
    v.map_or_else(|| "none".to_string(), |x| x.to_string())
}

fn slot_of(args: &[Val]) -> Slot {
    Slot::at(key(n(args, 1)), s(args, 2), s(args, 3))
}

fn stake_to(args: &[Val], to: Option<StakeTo>) -> String {
    match to {
        None => "ok none".to_string(),
        Some(StakeTo::Worker) => format!("ok {}", n(args, 1)),
        Some(StakeTo::Owner) => format!("ok {}", n(args, 0)),
    }
}

fn required_out(a: &[Val]) -> String {
    let (amount_in, now) = (u(a, 6), s(a, 7));
    let r = match n(a, 0) {
        0 => swap_exact_in::Params {
            amount_in: u(a, 1),
            min_out: u(a, 2),
        }
        .validate()
        .and_then(|p| Intent::SwapExactIn(p).required_out(amount_in, now)),
        1 => limit_order::Params {
            make_amount: u(a, 1),
            take_amount: u(a, 2),
        }
        .validate()
        .and_then(|p| Intent::LimitOrder(p).required_out(amount_in, now)),
        _ => dutch_auction::Params {
            amount_in: u(a, 1),
            start_out: u(a, 2),
            end_out: u(a, 3),
            start_ts: s(a, 4),
            end_ts: s(a, 5),
        }
        .validate()
        .and_then(|p| Intent::DutchAuction(p).required_out(amount_in, now)),
    };
    outcome(r, |v| v.to_string())
}

fn split_n_rust(a: &[Val]) -> String {
    let ws: Vec<u16> = l(a, 1).into_iter().map(w).collect();
    outcome(split_n(u(a, 0), &ws), |plan| {
        plan.as_slice()
            .iter()
            .map(u64::to_string)
            .collect::<Vec<_>>()
            .join(",")
    })
}

fn release_rust(a: &[Val]) -> String {
    let payees: Vec<[u8; 32]> = l(a, 4).into_iter().map(key).collect();
    let slot = slot_of(a);
    match slot.may_pay(&payees) {
        Ok(()) => stake_to(a, stake_on_release(slot, &payees)),
        Err(e) => format!("err {e:?}"),
    }
}

fn byte(v: i128) -> u8 {
    u8::try_from(v).unwrap_or(0)
}

fn fill<const N: usize>(args: &[Val], i: usize) -> [u8; N] {
    [byte(n(args, i)); N]
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn keys(args: &[Val], i: usize) -> Vec<[u8; 32]> {
    l(args, i).into_iter().map(key).collect()
}

fn blob_head_rust(a: &[Val]) -> String {
    let bytes: Vec<u8> = l(a, 0).into_iter().map(byte).collect();
    outcome(blob_head(&bytes), |h| {
        format!(
            "{} {} {} {}",
            h.count,
            h.mask,
            hex(h.fps.as_flattened()),
            h.url_len
        )
    })
}

fn closable_rust(a: &[Val]) -> String {
    let r = AnnState::try_from(byte(n(a, 0)))
        .and_then(|state| closable(state, n(a, 1) == 1, n(a, 2) == 1, s(a, 3), s(a, 4), s(a, 5)));
    outcome(r, |()| "done".to_string())
}

fn split_hash_rust(a: &[Val]) -> String {
    let weights: Vec<u16> = l(a, 1).into_iter().map(w).collect();
    outcome(split_hash_preimage(&keys(a, 0), &weights), |(out, len)| {
        format!("{} {len}", hex(&out))
    })
}

fn attested_delivery_rust(a: &[Val]) -> String {
    let p = AttestedDelivery {
        program: fill(a, 0),
        domain: fill(a, 1),
        intent: fill(a, 2),
        payee: fill(a, 3),
        amount_in: u(a, 4),
        result: u(a, 5),
        filled: u(a, 6),
        revision: secs(n(a, 7)),
        max_fee_bps: w(n(a, 8)),
        ext_hash: fill(a, 9),
        spec_hash: fill(a, 10),
        announcement: fill(a, 11),
        seq: u(a, 12),
        delivered: fill(a, 13),
        salt: fill(a, 14),
    };
    format!("ok {}", hex(&p.preimage()))
}

fn attested_split_delivery_rust(a: &[Val]) -> String {
    let p = AttestedSplitDelivery {
        program: fill(a, 0),
        domain: fill(a, 1),
        intent: fill(a, 2),
        amount_in: u(a, 3),
        result: u(a, 4),
        filled: u(a, 5),
        revision: secs(n(a, 6)),
        max_fee_bps: w(n(a, 7)),
        ext_hash: fill(a, 8),
        spec_hash: fill(a, 9),
        split_hash: fill(a, 10),
        announcement: fill(a, 11),
        seq: u(a, 12),
        delivered: fill(a, 13),
        salt: fill(a, 14),
    };
    format!("ok {}", hex(&p.preimage()))
}

pub const PAIRS: &[Pair] = &[
    Pair {
        name: "mul_div_floor",
        gen: mul_div_gen,
        rust: |a| outcome(mul_div_floor(u(a, 0), u(a, 1), u(a, 2)), |v| v.to_string()),
        same_refusal: &[],
    },
    Pair {
        name: "mul_div_ceil",
        gen: mul_div_gen,
        rust: |a| outcome(mul_div_ceil(u(a, 0), u(a, 1), u(a, 2)), |v| v.to_string()),
        same_refusal: &[],
    },
    Pair {
        name: "split_fee",
        gen: split_fee_gen,
        rust: |a| {
            outcome(split_fee(u(a, 0), w(n(a, 1))), |v| {
                format!("{} {}", v.fee, v.net)
            })
        },
        same_refusal: &[],
    },
    Pair {
        name: "split_fees",
        gen: split_fees_gen,
        rust: |a| {
            outcome(
                split_fees(u(a, 0), w(n(a, 1)), w(n(a, 2)), w(n(a, 3))),
                |v| format!("{} {} {}", v.protocol, v.partner, v.net),
            )
        },
        same_refusal: &[],
    },
    Pair {
        name: "release_settles",
        gen: release_settles_gen,
        rust: |a| {
            let settles = release_settles(u(a, 0), u(a, 1), w(n(a, 2)), w(n(a, 3)), w(n(a, 4)));
            format!("ok {settles}")
        },
        same_refusal: &[],
    },
    Pair {
        name: "split_n",
        gen: split_n_gen,
        rust: split_n_rust,
        same_refusal: &[],
    },
    Pair {
        name: "claim_terms",
        gen: claim_terms_gen,
        rust: |a| outcome(Terms::new(secs(n(a, 0)), u(a, 1)), |_| "done".to_string()),
        same_refusal: &[],
    },
    Pair {
        name: "claim_until",
        gen: claim_until_gen,
        rust: |a| {
            let until = Terms::new(secs(n(a, 0)), u(a, 1))
                .and_then(|t| t.until(s(a, 2), secs(n(a, 3)), s(a, 4)));
            outcome(until, |v| v.to_string())
        },
        same_refusal: &[],
    },
    Pair {
        name: "stake_on_release",
        gen: stake_on_release_gen,
        rust: release_rust,
        same_refusal: &[],
    },
    Pair {
        name: "stake_on_cancel",
        gen: board_gen,
        rust: |a| stake_to(a, stake_on_cancel(slot_of(a))),
        same_refusal: &[],
    },
    Pair {
        name: "stake_on_settle",
        gen: stake_on_settle_gen,
        rust: |a| match stake_on_settle(slot_of(a), n(a, 4) == 1) {
            Ok(to) => stake_to(a, to),
            Err(e) => format!("err {e:?}"),
        },
        same_refusal: &[],
    },
    Pair {
        name: "lane_of",
        gen: lane_of_gen,
        rust: |a| format!("ok {}", or_none(lane_of(u(a, 0)))),
        same_refusal: &[],
    },
    Pair {
        name: "in_lane",
        gen: in_lane_gen,
        rust: |a| format!("ok {}", in_lane(u(a, 0), u(a, 1))),
        same_refusal: &[],
    },
    Pair {
        name: "next_free",
        gen: next_free_gen,
        rust: |a| {
            let window = Window {
                base: u(a, 0),
                bits: [u(a, 1), u(a, 2), u(a, 3), u(a, 4)],
            };
            format!("ok {}", or_none(window.next_free()))
        },
        same_refusal: &[],
    },
    Pair {
        name: "required_out",
        gen: required_out_gen,
        rust: required_out,
        same_refusal: &[],
    },
    Pair {
        name: "commitment_preimage",
        gen: commitment_preimage_gen,
        rust: |a| {
            let p = commitment_preimage(&fill(a, 0), &fill(a, 1), &fill(a, 2), &fill(a, 3));
            format!("ok {}", hex(&p))
        },
        same_refusal: &[],
    },
    Pair {
        name: "fingerprint_preimage",
        gen: fingerprint_preimage_gen,
        rust: |a| format!("ok {}", hex(&fingerprint_preimage(&fill(a, 0)))),
        same_refusal: &[],
    },
    Pair {
        name: "blob_head",
        gen: blob_head_gen,
        rust: blob_head_rust,
        same_refusal: &[],
    },
    Pair {
        name: "may_announce",
        gen: may_announce_gen,
        rust: |a| {
            outcome(may_announce(slot_of(a), key(n(a, 4))), |()| {
                "done".to_string()
            })
        },
        same_refusal: &[],
    },
    Pair {
        name: "ann_state",
        gen: ann_state_gen,
        rust: |a| {
            outcome(AnnState::try_from(byte(n(a, 0))), |st| {
                u8::from(st).to_string()
            })
        },
        same_refusal: &[],
    },
    Pair {
        name: "closable",
        gen: closable_gen,
        rust: closable_rust,
        same_refusal: &[],
    },
    Pair {
        name: "refutes",
        gen: refutes_gen,
        rust: |a| {
            outcome(refutes(u(a, 0), u(a, 1), key(n(a, 2)), &keys(a, 3)), |()| {
                "done".to_string()
            })
        },
        same_refusal: &[],
    },
    Pair {
        name: "split_hash_preimage",
        gen: split_hash_preimage_gen,
        rust: split_hash_rust,
        same_refusal: &[],
    },
    Pair {
        name: "attested_delivery_preimage",
        gen: attested_delivery_preimage_gen,
        rust: attested_delivery_rust,
        same_refusal: &[],
    },
    Pair {
        name: "attested_split_delivery_preimage",
        gen: attested_split_delivery_preimage_gen,
        rust: attested_split_delivery_rust,
        same_refusal: &[],
    },
];
