#![no_main]

use intent_core::sig::{
    offchain_envelope, AttestedFill, AttestedProof, SignedIntent, ATTEST_PROOF_TAG, ATTEST_TAG,
    INTENT_TAG, OFFCHAIN_PREFIX,
};
use intent_core::PARAMS_LEN;
use libfuzzer_sys::fuzz_target;

type Keys = [[u8; 32]; 7];
type Signed = (Keys, u64, i64, i64, u8, u16, [u8; PARAMS_LEN], u64, [u8; 32], u64);
type Attest = ([[u8; 32]; 5], u64, u64, u64, u32, u16, [u8; 32]);

fn take<'a>(at: &mut usize, bytes: &'a [u8], n: usize) -> &'a [u8] {
    let s = &bytes[*at..*at + n];
    *at += n;
    s
}

fn u64_at(at: &mut usize, bytes: &[u8]) -> u64 {
    u64::from_le_bytes(take(at, bytes, 8).try_into().unwrap())
}

fuzz_target!(|input: (Signed, Attest)| {
    let ((keys, nonce, expires_at, submit_by, kind, flags, params, epoch, ext_hash, relayer_fee), a) = input;
    let [program, domain, owner, owner_input, input_mint, output_mint, receiver] = keys;
    let intent = SignedIntent {
        program,
        domain,
        owner,
        owner_input,
        input_mint,
        output_mint,
        receiver,
        nonce,
        expires_at,
        submit_by,
        kind,
        flags,
        params: &params,
        epoch,
        ext_hash,
        relayer_fee,
    };
    let pre = intent.preimage();
    let mut at = 0;
    assert_eq!(take(&mut at, &pre, 16), &INTENT_TAG[..]);
    for k in &keys {
        assert_eq!(take(&mut at, &pre, 32), &k[..]);
    }
    assert_eq!(u64_at(&mut at, &pre), nonce);
    assert_eq!(u64_at(&mut at, &pre) as i64, expires_at);
    assert_eq!(u64_at(&mut at, &pre) as i64, submit_by);
    assert_eq!(take(&mut at, &pre, 1), &[kind][..]);
    assert_eq!(take(&mut at, &pre, 2), &flags.to_le_bytes()[..]);
    assert_eq!(take(&mut at, &pre, 5), &[0u8; 5][..]);
    assert_eq!(take(&mut at, &pre, PARAMS_LEN), &params[..]);
    assert_eq!(u64_at(&mut at, &pre), epoch);
    assert_eq!(take(&mut at, &pre, 32), &ext_hash[..]);
    assert_eq!(u64_at(&mut at, &pre), relayer_fee);
    assert_eq!(at, pre.len());

    let ([program, domain, intent_key, payee, ext_hash], amount_in, result, filled, revision, max_fee_bps, spec_hash) = a;
    let fill = AttestedFill {
        program,
        domain,
        intent: intent_key,
        payee,
        amount_in,
        result,
        filled,
        revision,
        max_fee_bps,
        ext_hash,
    };
    let pre_a = fill.preimage();
    let mut at = 0;
    assert_eq!(take(&mut at, &pre_a, 16), &ATTEST_TAG[..]);
    for k in [program, domain, intent_key, payee] {
        assert_eq!(take(&mut at, &pre_a, 32), &k[..]);
    }
    assert_eq!(u64_at(&mut at, &pre_a), amount_in);
    assert_eq!(u64_at(&mut at, &pre_a), result);
    assert_eq!(u64_at(&mut at, &pre_a), filled);
    assert_eq!(take(&mut at, &pre_a, 4), &revision.to_le_bytes()[..]);
    assert_eq!(take(&mut at, &pre_a, 2), &max_fee_bps.to_le_bytes()[..]);
    assert_eq!(take(&mut at, &pre_a, 32), &ext_hash[..]);
    assert_eq!(at, pre_a.len());
    assert_ne!(pre[..16], pre_a[..16]);

    let proof = AttestedProof {
        program,
        domain,
        intent: intent_key,
        payee,
        amount_in,
        result,
        filled,
        revision,
        max_fee_bps,
        ext_hash,
        spec_hash,
    };
    let pre_p = proof.preimage();
    let mut at = 0;
    assert_eq!(take(&mut at, &pre_p, 16), &ATTEST_PROOF_TAG[..]);
    for k in [program, domain, intent_key, payee] {
        assert_eq!(take(&mut at, &pre_p, 32), &k[..]);
    }
    assert_eq!(u64_at(&mut at, &pre_p), amount_in);
    assert_eq!(u64_at(&mut at, &pre_p), result);
    assert_eq!(u64_at(&mut at, &pre_p), filled);
    assert_eq!(take(&mut at, &pre_p, 4), &revision.to_le_bytes()[..]);
    assert_eq!(take(&mut at, &pre_p, 2), &max_fee_bps.to_le_bytes()[..]);
    assert_eq!(take(&mut at, &pre_p, 32), &ext_hash[..]);
    assert_eq!(take(&mut at, &pre_p, 32), &spec_hash[..]);
    assert_eq!(at, pre_p.len());
    assert_eq!(&pre_p[16..pre_a.len()], &pre_a[16..]);
    assert_ne!(pre_p[..16], pre_a[..16]);
    assert_ne!(pre_p[..16], pre[..16]);

    let env = offchain_envelope(&owner, &ext_hash);
    assert_eq!(&env[..16], &OFFCHAIN_PREFIX[..]);
    assert_eq!(&env[18..50], &owner[..]);
    let hex: Vec<u8> = env[50..]
        .chunks(2)
        .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
        .collect();
    assert_eq!(hex, ext_hash);
    assert!(env[50..].iter().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c)));
});
