use intent_core::fee::{release_settles, split_fees, BPS_DENOMINATOR};
use proptest::prelude::*;
use std::path::PathBuf;

const CASES: usize = 400;

struct SplitMix(u64);

impl SplitMix {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next().checked_rem(n).unwrap_or(0)
    }

    fn bps(&mut self) -> u16 {
        match self.below(4) {
            0 => 0,
            1 => u16::try_from(self.below(50)).unwrap_or(0),
            2 => u16::try_from(10_000u64.saturating_sub(self.below(3))).unwrap_or(0),
            _ => u16::try_from(self.below(10_001)).unwrap_or(0),
        }
    }

    fn amount(&mut self) -> u64 {
        match self.below(4) {
            0 => self.next(),
            1 => self.below(1_000_000),
            2 => self.below(40),
            _ => u64::MAX.saturating_sub(self.below(1_000)),
        }
    }

    fn judge_fee(&mut self, amount: u64) -> u64 {
        match self.below(4) {
            0 => 0,
            1 => amount.saturating_sub(self.below(6)),
            2 => amount.saturating_add(self.below(2)),
            _ => self.below(amount.saturating_add(1).max(1)),
        }
    }
}

struct Case {
    amount: u64,
    judge_fee: u64,
    fee_bps: u16,
    partner_bps: u16,
    cut_bps: u16,
}

fn cases() -> Vec<Case> {
    let mut fixed = vec![
        (400, 399, 5, 50, 0),
        (400, 398, 5, 50, 0),
        (3, 1, 100, 100, 0),
        (2, 1, 100, 100, 0),
        (1, 1, 0, 0, 0),
        (0, 0, 0, 0, 0),
        (1, 0, 0, 0, 0),
        (5, 5, 0, 0, 0),
        (u64::MAX, 18_446_744_073_709_551_614, 10_000, 0, 0),
        (u64::MAX, 0, 10_000, 1, 10_000),
        (u64::MAX, 0, 5_000, 5_000, 2_000),
        (4, 1, 5_000, 5_000, 10_000),
    ]
    .into_iter()
    .map(|(amount, judge_fee, fee_bps, partner_bps, cut_bps)| Case {
        amount,
        judge_fee,
        fee_bps,
        partner_bps,
        cut_bps,
    })
    .collect::<Vec<_>>();
    let mut r = SplitMix(0x5e77_1e5e_ed00_0080);
    for _ in 0..CASES {
        let amount = r.amount();
        let judge_fee = r.judge_fee(amount);
        fixed.push(Case {
            amount,
            judge_fee,
            fee_bps: r.bps(),
            partner_bps: r.bps(),
            cut_bps: r.bps(),
        });
    }
    fixed
}

fn rendered() -> String {
    let rows = cases()
        .iter()
        .map(|c| {
            format!(
                "    {{ \"amount\": \"{}\", \"judge_fee\": \"{}\", \"fee_bps\": {}, \"partner_bps\": {}, \"cut_bps\": {}, \"settles\": {} }}",
                c.amount,
                c.judge_fee,
                c.fee_bps,
                c.partner_bps,
                c.cut_bps,
                release_settles(c.amount, c.judge_fee, c.fee_bps, c.partner_bps, c.cut_bps)
            )
        })
        .collect::<Vec<_>>();
    format!("{{\n  \"cases\": [\n{}\n  ]\n}}\n", rows.join(",\n"))
}

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/core/test/golden/release-settles.json")
}

#[test]
fn the_shared_release_table_matches_the_committed_fixture() -> Result<(), Box<dyn std::error::Error>>
{
    let rendered = rendered();
    let path = fixture_path();
    if std::env::var_os("GOLDEN_WRITE").is_some() {
        std::fs::write(&path, &rendered)?;
    }
    let committed = std::fs::read_to_string(&path)?.replace("\r\n", "\n");
    assert_eq!(
        committed, rendered,
        "packages/core/test/golden/release-settles.json drifted from release_settles; rerun with GOLDEN_WRITE=1 and review the diff"
    );
    Ok(())
}

#[test]
fn the_shared_table_holds_both_outcomes_on_the_boundary() {
    let all = cases();
    let settling = all
        .iter()
        .filter(|c| release_settles(c.amount, c.judge_fee, c.fee_bps, c.partner_bps, c.cut_bps))
        .count();
    assert!(settling > CASES / 8);
    assert!(all.len().saturating_sub(settling) > CASES / 8);
    assert!(!release_settles(400, 399, 5, 50, 0));
    assert!(release_settles(400, 398, 5, 50, 0));
}

fn ceil_bps(amount: u64, bps: u16) -> u128 {
    let denominator = u128::from(BPS_DENOMINATOR);
    u128::from(amount)
        .wrapping_mul(u128::from(bps))
        .div_ceil(denominator)
}

proptest! {
    #[test]
    fn a_release_settles_exactly_when_the_rest_covers_the_rounded_up_fees(
        amount in prop_oneof![any::<u64>(), 0u64..64],
        judge_offset in 0u64..64,
        fee_bps in 0u16..=10_000,
        partner_bps in 0u16..=10_000,
        cut_bps in 0u16..=10_000,
    ) {
        let judge_fee = amount.saturating_sub(judge_offset);
        let settles = release_settles(amount, judge_fee, fee_bps, partner_bps, cut_bps);
        let model = amount > judge_fee && {
            let rest = amount.saturating_sub(judge_fee);
            ceil_bps(rest, fee_bps).wrapping_add(ceil_bps(rest, partner_bps)) <= u128::from(rest)
        };
        prop_assert_eq!(settles, model);
        if settles {
            let rest = amount.saturating_sub(judge_fee);
            let fees = split_fees(rest, fee_bps, partner_bps, cut_bps);
            prop_assert!(fees.is_ok());
            if let Ok(f) = fees {
                let total = [judge_fee, f.protocol, f.partner, f.net]
                    .iter()
                    .fold(0u128, |sum, part| sum.wrapping_add(u128::from(*part)));
                prop_assert_eq!(total, u128::from(amount));
            }
        }
    }
}
