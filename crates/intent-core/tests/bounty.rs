use intent_core::bounty::{split_n, MAX_RECIPIENTS};
use intent_core::Error;

#[test]
fn a_split_distributes_every_lamport_with_no_loss() -> Result<(), Error> {
    let plan = split_n(1_000_000, &[4000, 5000, 1000])?;
    assert_eq!(plan.as_slice(), &[400_000, 500_000, 100_000]);
    assert_eq!(plan.total(), 1_000_000);
    Ok(())
}

#[test]
fn a_split_rounds_each_share_down_and_hands_the_dust_to_the_heaviest_weight() -> Result<(), Error> {
    let plan = split_n(100, &[3333, 3333, 3334])?;
    assert_eq!(plan.as_slice(), &[33, 33, 34]);
    assert_eq!(plan.total(), 100);
    Ok(())
}

#[test]
fn a_one_basis_point_recipient_still_receives_its_lamport() -> Result<(), Error> {
    let plan = split_n(10_000, &[1, 9999])?;
    assert_eq!(plan.as_slice(), &[1, 9999]);
    assert_eq!(plan.total(), 10_000);
    Ok(())
}

#[test]
fn a_split_conserves_across_many_amounts_and_weight_vectors() -> Result<(), Error> {
    let vectors: [&[u16]; 4] = [
        &[10_000],
        &[2500, 2500, 2500, 2500],
        &[1, 1, 9998],
        &[3000, 3000, 3000, 999, 1],
    ];
    for weights in vectors {
        for amount in [0u64, 1, 7, 999, 1_000_000, u64::from(u32::MAX)] {
            let plan = split_n(amount, weights)?;
            assert_eq!(plan.total(), amount, "weights {weights:?} amount {amount}");
            assert_eq!(plan.as_slice().len(), weights.len());
        }
    }
    Ok(())
}

#[test]
fn a_split_refuses_weights_that_do_not_sum_to_the_whole() {
    assert_eq!(split_n(100, &[4000, 5000]), Err(Error::InvalidParams));
    assert_eq!(split_n(100, &[5000, 6000]), Err(Error::InvalidParams));
}

#[test]
fn a_split_refuses_an_empty_or_oversized_recipient_set() {
    assert_eq!(split_n(100, &[]), Err(Error::InvalidParams));
    let too_many = [1u16; MAX_RECIPIENTS + 1];
    assert_eq!(split_n(100, &too_many), Err(Error::InvalidParams));
}

#[test]
fn a_split_at_the_recipient_ceiling_is_accepted_and_conserves() -> Result<(), Error> {
    let weights = [625u16; MAX_RECIPIENTS];
    let plan = split_n(1_000_003, &weights)?;
    assert_eq!(plan.total(), 1_000_003);
    assert_eq!(plan.as_slice().len(), MAX_RECIPIENTS);
    Ok(())
}
