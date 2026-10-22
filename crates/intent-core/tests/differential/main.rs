mod gen;
mod oracle;
mod pairs;
mod rng;

use oracle::Oracle;
use pairs::{Pair, Val, PAIRS};
use rng::Rng;

const DEFAULT_SEED: u64 = 0x5eed_d1ff_c0de_2026;
const DEFAULT_CASES: usize = 10_000;
const SHRINK_BUDGET: usize = 4_000;

fn seed() -> Result<u64, String> {
    match std::env::var("DIFF_SEED") {
        Err(_) => Ok(DEFAULT_SEED),
        Ok(text) => {
            let parsed = match text.strip_prefix("0x") {
                Some(hex) => u64::from_str_radix(hex, 16),
                None => text.parse(),
            };
            parsed.map_err(|_| format!("DIFF_SEED must be a u64, not {text}"))
        }
    }
}

fn cases() -> Result<usize, String> {
    match std::env::var("DIFF_CASES") {
        Err(_) => Ok(DEFAULT_CASES),
        Ok(text) => text
            .parse()
            .ok()
            .filter(|n| *n > 0)
            .ok_or(format!("DIFF_CASES must be a positive count, not {text}")),
    }
}

fn encode(v: &Val) -> String {
    match v {
        Val::N(x) => x.to_string(),
        Val::L(xs) => {
            let items: Vec<String> = xs.iter().map(i128::to_string).collect();
            format!("L{}", items.join(","))
        }
    }
}

fn request(pair: &Pair, args: &[Val]) -> String {
    let mut line = pair.name.to_string();
    for a in args {
        line.push(' ');
        line.push_str(&encode(a));
    }
    line
}

fn agrees(pair: &Pair, rust: &str, ts: &str) -> bool {
    if rust == ts {
        return true;
    }
    match (rust.strip_prefix("err "), ts.strip_prefix("err ")) {
        (Some(r), Some(t)) => pair.same_refusal.contains(&(r, t)),
        _ => false,
    }
}

fn smaller(v: i128) -> Vec<i128> {
    let mut out = Vec::new();
    for c in [
        0,
        v.checked_div(2).unwrap_or(0),
        v.saturating_sub(v.signum()),
    ] {
        if c != v && !out.contains(&c) {
            out.push(c);
        }
    }
    out
}

fn candidates(args: &[Val]) -> Vec<Vec<Val>> {
    let mut out = Vec::new();
    for (i, a) in args.iter().enumerate() {
        let mut with = |v: Val| {
            let mut next = args.to_vec();
            if let Some(slot) = next.get_mut(i) {
                *slot = v;
            }
            out.push(next);
        };
        match a {
            Val::N(x) => smaller(*x).into_iter().for_each(|c| with(Val::N(c))),
            Val::L(xs) => {
                for j in 0..xs.len() {
                    let mut fewer = xs.clone();
                    fewer.remove(j);
                    with(Val::L(fewer));
                }
                for (j, x) in xs.iter().enumerate() {
                    for c in smaller(*x) {
                        let mut lower = xs.clone();
                        if let Some(slot) = lower.get_mut(j) {
                            *slot = c;
                        }
                        with(Val::L(lower));
                    }
                }
            }
        }
    }
    out
}

fn shrink(oracle: &mut Oracle, pair: &Pair, first: &[Val]) -> Result<Vec<Val>, String> {
    let mut best = first.to_vec();
    let mut budget = SHRINK_BUDGET;
    'outer: while budget > 0 {
        for c in candidates(&best) {
            budget = budget.saturating_sub(1);
            let ts = oracle.ask(request(pair, &c))?;
            if !agrees(pair, &(pair.rust)(&c), &ts) {
                best = c;
                continue 'outer;
            }
            if budget == 0 {
                break;
            }
        }
        break;
    }
    Ok(best)
}

fn check(
    oracle: &mut Oracle,
    pair: &Pair,
    seed: u64,
    cases: usize,
) -> Result<Option<String>, String> {
    let stream = seed ^ fxhash(pair.name);
    let mut r = Rng::new(stream);
    let inputs: Vec<Vec<Val>> = (0..cases).map(|_| (pair.gen)(&mut r)).collect();
    let lines: Vec<String> = inputs.iter().map(|a| request(pair, a)).collect();
    let answers = oracle.batch(&lines)?;
    let failing: Vec<&Vec<Val>> = inputs
        .iter()
        .zip(&answers)
        .filter(|(a, ts)| !agrees(pair, &(pair.rust)(a), ts))
        .map(|(a, _)| a)
        .collect();
    let Some(first) = failing.first() else {
        return Ok(None);
    };
    let small = shrink(oracle, pair, first)?;
    let ts = oracle.ask(request(pair, &small))?;
    Ok(Some(format!(
        "pair {}: {} of {cases} cases disagree (DIFF_SEED={seed}); smallest input `{}`: rust `{}`, typescript `{ts}`; first input `{}`",
        pair.name,
        failing.len(),
        request(pair, &small),
        (pair.rust)(&small),
        request(pair, first),
    )))
}

fn fxhash(name: &str) -> u64 {
    name.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
    })
}

#[test]
fn typescript_core_agrees_with_rust_core_on_every_pair() -> Result<(), String> {
    let seed = seed()?;
    let cases = cases()?;
    let wanted: Vec<String> = std::env::var("DIFF_PAIRS")
        .map(|v| v.split(',').map(str::to_string).collect())
        .unwrap_or_default();
    let unknown: Vec<&String> = wanted
        .iter()
        .filter(|w| !PAIRS.iter().any(|p| p.name == w.as_str()))
        .collect();
    assert!(unknown.is_empty(), "DIFF_PAIRS names no pair: {unknown:?}");
    let mut oracle = Oracle::start()?;
    let mut failures = Vec::new();
    for pair in PAIRS {
        if !wanted.is_empty() && !wanted.iter().any(|w| w == pair.name) {
            continue;
        }
        if let Some(failure) = check(&mut oracle, pair, seed, cases)? {
            failures.push(failure);
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    Ok(())
}
