use intent_core::bounty::split_n;
use intent_core::fee::{split_fees, BPS_DENOMINATOR};
use intent_core::Error;

#[test]
fn the_fee_cut_and_the_payout_split_together_spend_every_lamport_at_mainnet_scale(
) -> Result<(), Error> {
    let weights: [&[u16]; 5] = [
        &[10_000],
        &[2500, 2500, 2500, 2500],
        &[1, 9999],
        &[3333, 3333, 3334],
        &[625; 16],
    ];
    let terms: [(u16, u16, u16); 6] = [
        (0, 0, 0),
        (100, 100, 10_000),
        (100, 100, 0),
        (1, 0, 10_000),
        (0, 1, 10_000),
        (100, 0, 5_000),
    ];
    let amounts: [u64; 6] = [
        u64::MAX,
        u64::MAX - 1,
        u64::MAX / 2,
        18_000_000_000_000_000_001,
        1_000_000_000_000,
        999_999_999_937,
    ];
    for weight in weights {
        for (fee_bps, partner_bps, cut_bps) in terms {
            for amount in amounts {
                let fees = split_fees(amount, fee_bps, partner_bps, cut_bps)?;
                let plan = split_n(fees.net, weight)?;
                assert_eq!(plan.as_slice().len(), weight.len());
                assert_eq!(
                    plan.total(),
                    fees.net,
                    "net {amount} {fee_bps} {partner_bps} {cut_bps} {weight:?}"
                );
                assert_eq!(
                    fees.protocol
                        .checked_add(fees.partner)
                        .and_then(|taken| taken.checked_add(plan.total())),
                    Some(amount),
                    "conserve {amount} {fee_bps} {partner_bps} {cut_bps} {weight:?}"
                );
                let taken = fees
                    .protocol
                    .checked_add(fees.partner)
                    .ok_or(Error::Overflow)?;
                let rate = u128::from(fee_bps)
                    .checked_add(u128::from(partner_bps))
                    .ok_or(Error::Overflow)?;
                let claimed = u128::from(amount)
                    .checked_mul(rate)
                    .ok_or(Error::Overflow)?;
                let charged = u128::from(taken)
                    .checked_mul(u128::from(BPS_DENOMINATOR))
                    .ok_or(Error::Overflow)?;
                assert!(
                    charged >= claimed,
                    "undercharge {amount} {fee_bps} {partner_bps} {cut_bps}"
                );
            }
        }
    }
    Ok(())
}
