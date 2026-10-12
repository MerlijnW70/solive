use intent_core::kinds::{attested_result::Params, swap_exact_in, Intent, Kind};
use intent_core::{Error, PARAMS_LEN};

fn params(min_result: u64, max_result: u64) -> Params {
    Params {
        amount_in: 50,
        min_result,
        max_result,
        attestor: [9; 32],
        spec_hash: [0; 32],
        judge_fee: 0,
    }
}

#[test]
fn layout_is_three_le_u64_the_attestor_then_the_proof_commitment() -> Result<(), Error> {
    let p = Params {
        amount_in: 1,
        min_result: 2,
        max_result: 3,
        attestor: [0xab; 32],
        spec_hash: [0; 32],
        judge_fee: 0,
    };
    let bytes = p.encode()?;
    assert_eq!(bytes.get(0..8), Some(&[1, 0, 0, 0, 0, 0, 0, 0][..]));
    assert_eq!(bytes.get(8..16), Some(&[2, 0, 0, 0, 0, 0, 0, 0][..]));
    assert_eq!(bytes.get(16..24), Some(&[3, 0, 0, 0, 0, 0, 0, 0][..]));
    assert_eq!(bytes.get(24..56), Some(&[0xab; 32][..]));
    assert_eq!(bytes.get(56..), Some(&[0u8; PARAMS_LEN - 56][..]));
    assert_eq!(Params::decode(&bytes), Ok(p));
    assert_eq!(Intent::decode(4, &bytes), Ok(Intent::AttestedResult(p)));

    let proof = Params {
        amount_in: 100,
        spec_hash: [0xcd; 32],
        judge_fee: 7,
        ..p
    };
    let pb = proof.encode()?;
    assert_eq!(pb.get(56..88), Some(&[0xcd; 32][..]));
    assert_eq!(pb.get(88..96), Some(&[7, 0, 0, 0, 0, 0, 0, 0][..]));
    assert_eq!(pb.get(96..), Some(&[0u8; PARAMS_LEN - 96][..]));
    assert_eq!(Params::decode(&pb), Ok(proof));
    assert!(proof.is_proof() && !p.is_proof());
    Ok(())
}

#[test]
fn a_plain_attested_buffer_still_decodes_with_an_empty_proof_commitment() -> Result<(), Error> {
    let mut bytes = [0u8; PARAMS_LEN];
    bytes
        .get_mut(0..8)
        .ok_or(Error::Truncated)?
        .copy_from_slice(&50u64.to_le_bytes());
    bytes
        .get_mut(8..16)
        .ok_or(Error::Truncated)?
        .copy_from_slice(&10u64.to_le_bytes());
    bytes
        .get_mut(16..24)
        .ok_or(Error::Truncated)?
        .copy_from_slice(&20u64.to_le_bytes());
    bytes
        .get_mut(24..56)
        .ok_or(Error::Truncated)?
        .copy_from_slice(&[9u8; 32]);
    let p = Params::decode(&bytes)?;
    assert_eq!(
        (p.spec_hash, p.judge_fee, p.is_proof()),
        ([0; 32], 0, false)
    );
    Ok(())
}

#[test]
fn validation_rejects_each_bad_field() {
    assert_eq!(params(5, 5).validate(), Ok(params(5, 5)));
    assert_eq!(params(0, u64::MAX).validate(), Ok(params(0, u64::MAX)));
    assert_eq!(params(6, 5).validate(), Err(Error::InvalidParams));
    let zero_in = Params {
        amount_in: 0,
        ..params(1, 2)
    };
    assert_eq!(zero_in.validate(), Err(Error::InvalidParams));
    let no_attestor = Params {
        attestor: [0; 32],
        ..params(1, 2)
    };
    assert_eq!(no_attestor.validate(), Err(Error::InvalidParams));
    let mut one_bit = [0u8; 32];
    if let Some(b) = one_bit.get_mut(31) {
        *b = 1;
    }
    let near_zero = Params {
        attestor: one_bit,
        ..params(1, 2)
    };
    assert_eq!(near_zero.validate(), Ok(near_zero));
}

#[test]
fn a_judge_fee_without_a_committed_spec_is_rejected() {
    let fee_no_spec = Params {
        judge_fee: 5,
        ..params(1, 2)
    };
    assert_eq!(fee_no_spec.validate(), Err(Error::InvalidParams));
    let fee_with_spec = Params {
        spec_hash: [1; 32],
        judge_fee: 5,
        ..params(1, 2)
    };
    assert_eq!(fee_with_spec.validate(), Ok(fee_with_spec));
    let spec_no_fee = Params {
        spec_hash: [1; 32],
        ..params(1, 2)
    };
    assert_eq!(spec_no_fee.validate(), Ok(spec_no_fee));
    let fee_eats_escrow = Params {
        amount_in: 50,
        spec_hash: [1; 32],
        judge_fee: 50,
        ..params(1, 2)
    };
    assert_eq!(fee_eats_escrow.validate(), Err(Error::InvalidParams));
    let fee_just_under = Params {
        amount_in: 50,
        spec_hash: [1; 32],
        judge_fee: 49,
        ..params(1, 2)
    };
    assert_eq!(fee_just_under.validate(), Ok(fee_just_under));
}

#[test]
fn trailing_bytes_after_the_proof_commitment_are_rejected() -> Result<(), Error> {
    let mut bytes = params(1, 2).encode()?;
    if let Some(b) = bytes.get_mut(96) {
        *b = 1;
    }
    assert_eq!(Params::decode(&bytes), Err(Error::NonCanonical));
    Ok(())
}

#[test]
fn result_must_lie_within_the_signed_bounds() {
    let p = params(10, 20);
    assert_eq!(p.check_result(50, 10), Ok(()));
    assert_eq!(p.check_result(50, 15), Ok(()));
    assert_eq!(p.check_result(50, 20), Ok(()));
    assert_eq!(p.check_result(50, 9), Err(Error::ResultOutOfBounds));
    assert_eq!(p.check_result(50, 21), Err(Error::ResultOutOfBounds));
    assert_eq!(p.check_result(49, 15), Err(Error::AmountMismatch));
    assert_eq!(p.check_result(51, 15), Err(Error::AmountMismatch));
}

#[test]
fn attested_intents_only_settle_by_attestation() {
    let attested = Intent::AttestedResult(params(10, 20));
    let swap = Intent::SwapExactIn(swap_exact_in::Params {
        amount_in: 50,
        min_out: 1,
    });
    assert_eq!(attested.kind(), Kind::AttestedResult);
    assert_eq!(attested.escrow_amount(), 50);
    assert_eq!(attested.required_out(50, 0), Err(Error::KindMismatch));
    assert_eq!(attested.settle(50, u64::MAX, 0), Err(Error::KindMismatch));
    assert_eq!(attested.check_attested(50, 15), Ok([9; 32]));
    assert_eq!(
        attested.check_attested(50, 21),
        Err(Error::ResultOutOfBounds)
    );
    assert!(attested.fits_expiry(i64::MIN));
    assert_eq!(swap.check_attested(50, 15), Err(Error::KindMismatch));
}
