use intent_core::sig::{
    check_ed25519_batch, check_ed25519_ix, ed25519_header, offchain_envelope, AttestedFill,
    AttestedProof, AttestedSplit, SignedIntent, ATTEST_PROOF_TAG, ATTEST_SPLIT_TAG, ATTEST_TAG,
    ED25519_PROGRAM_ID, INTENT_TAG, OFFCHAIN_PREFIX,
};
use intent_core::Error;

const PK: [u8; 32] = [7; 32];

fn ix_data(message: &[u8]) -> Vec<u8> {
    let len = u16::try_from(message.len()).unwrap_or(u16::MAX);
    let mut data = ed25519_header(len).to_vec();
    data.extend_from_slice(&PK);
    data.extend_from_slice(&[0xee; 64]);
    data.extend_from_slice(message);
    data
}

fn flipped(mut data: Vec<u8>, at: usize) -> Vec<u8> {
    if let Some(b) = data.get_mut(at) {
        *b ^= 0x01;
    }
    data
}

#[test]
fn header_pins_one_signature_inside_this_instruction() {
    assert_eq!(
        ed25519_header(114),
        [1, 0, 48, 0, 0xff, 0xff, 16, 0, 0xff, 0xff, 112, 0, 114, 0, 0xff, 0xff]
    );
    assert_eq!(
        ed25519_header(0x0102),
        [1, 0, 48, 0, 0xff, 0xff, 16, 0, 0xff, 0xff, 112, 0, 2, 1, 0xff, 0xff]
    );
}

#[test]
fn exact_instruction_is_accepted() {
    let msg = [5u8; 114];
    assert_eq!(
        check_ed25519_ix(&ED25519_PROGRAM_ID, &ix_data(&msg), &PK, &msg),
        Ok(())
    );
}

#[test]
fn other_program_is_rejected_before_anything_else() {
    let msg = [5u8; 114];
    let mut other = ED25519_PROGRAM_ID;
    if let Some(b) = other.get_mut(31) {
        *b = 1;
    }
    assert_eq!(
        check_ed25519_ix(&other, &ix_data(&msg), &PK, &msg),
        Err(Error::SigProgram)
    );
    assert_eq!(
        check_ed25519_ix(&other, &[], &PK, &msg),
        Err(Error::SigProgram)
    );
}

#[test]
fn any_change_to_the_header_is_rejected() {
    let msg = [5u8; 114];
    for at in 0..16 {
        assert_eq!(
            check_ed25519_ix(&ED25519_PROGRAM_ID, &flipped(ix_data(&msg), at), &PK, &msg),
            Err(Error::SigHeader),
            "byte {at}"
        );
    }
    assert_eq!(
        check_ed25519_ix(&ED25519_PROGRAM_ID, &[1, 0, 48], &PK, &msg),
        Err(Error::SigHeader)
    );
}

#[test]
fn wrong_or_missing_pubkey_is_rejected() {
    let msg = [5u8; 114];
    for at in [16, 31, 47] {
        assert_eq!(
            check_ed25519_ix(&ED25519_PROGRAM_ID, &flipped(ix_data(&msg), at), &PK, &msg),
            Err(Error::SigPubkey),
            "byte {at}"
        );
    }
    let short: Vec<u8> = ix_data(&msg).into_iter().take(47).collect();
    assert_eq!(
        check_ed25519_ix(&ED25519_PROGRAM_ID, &short, &PK, &msg),
        Err(Error::SigPubkey)
    );
}

#[test]
fn signature_bytes_are_left_to_the_precompile() {
    let msg = [5u8; 114];
    for at in [48, 80, 111] {
        assert_eq!(
            check_ed25519_ix(&ED25519_PROGRAM_ID, &flipped(ix_data(&msg), at), &PK, &msg),
            Ok(()),
            "byte {at}"
        );
    }
}

#[test]
fn message_must_match_exactly_with_nothing_trailing() {
    let msg = [5u8; 114];
    for at in [112, 170, 225] {
        assert_eq!(
            check_ed25519_ix(&ED25519_PROGRAM_ID, &flipped(ix_data(&msg), at), &PK, &msg),
            Err(Error::SigMessage),
            "byte {at}"
        );
    }
    let mut long = ix_data(&msg);
    long.push(0);
    assert_eq!(
        check_ed25519_ix(&ED25519_PROGRAM_ID, &long, &PK, &msg),
        Err(Error::SigMessage)
    );
    let mut short = ix_data(&msg);
    short.pop();
    assert_eq!(
        check_ed25519_ix(&ED25519_PROGRAM_ID, &short, &PK, &msg),
        Err(Error::SigMessage)
    );
}

#[test]
fn messages_too_long_for_the_precompile_are_rejected() {
    let huge = vec![0u8; 70_000];
    assert_eq!(
        check_ed25519_ix(&ED25519_PROGRAM_ID, &ix_data(&[]), &PK, &huge),
        Err(Error::SigMessage)
    );
}

fn batch_data(pubkeys: &[[u8; 32]], message: &[u8]) -> Vec<u8> {
    let m = pubkeys.len();
    let len = u16::try_from(message.len()).unwrap_or(u16::MAX);
    let pubkeys_at = 14usize.saturating_mul(m).saturating_add(2);
    let sigs_at = pubkeys_at.saturating_add(32usize.saturating_mul(m));
    let message_at = sigs_at.saturating_add(64usize.saturating_mul(m));
    let le = |v: usize| u16::try_from(v).unwrap_or(u16::MAX).to_le_bytes();
    let mut data = vec![u8::try_from(m).unwrap_or(u8::MAX), 0];
    for k in 0..m {
        data.extend_from_slice(&le(sigs_at.saturating_add(64usize.saturating_mul(k))));
        data.extend_from_slice(&u16::MAX.to_le_bytes());
        data.extend_from_slice(&le(pubkeys_at.saturating_add(32usize.saturating_mul(k))));
        data.extend_from_slice(&u16::MAX.to_le_bytes());
        data.extend_from_slice(&le(message_at));
        data.extend_from_slice(&len.to_le_bytes());
        data.extend_from_slice(&u16::MAX.to_le_bytes());
    }
    for pk in pubkeys {
        data.extend_from_slice(pk);
    }
    for _ in 0..m {
        data.extend_from_slice(&[0xee; 64]);
    }
    data.extend_from_slice(message);
    data
}

#[test]
fn a_batch_of_co_signatures_over_one_shared_message_is_accepted() {
    let msg = offchain_envelope(&[9; 32], &[0x33; 32]);
    for count in [1usize, 3, 9] {
        let keys: Vec<[u8; 32]> = (0..count)
            .map(|k| [u8::try_from(k).unwrap_or(0); 32])
            .collect();
        assert_eq!(
            check_ed25519_batch(&ED25519_PROGRAM_ID, &batch_data(&keys, &msg), &keys, &msg),
            Ok(())
        );
    }
}

#[test]
fn a_batch_binds_every_pubkey_the_count_and_the_shared_message() {
    let msg = offchain_envelope(&[9; 32], &[0x33; 32]);
    let keys = [[1u8; 32], [2; 32], [3; 32]];
    let data = batch_data(&keys, &msg);
    assert_eq!(
        check_ed25519_batch(&ED25519_PROGRAM_ID, &data, &keys, &msg),
        Ok(())
    );
    let wrong = check_ed25519_batch(
        &ED25519_PROGRAM_ID,
        &data,
        &[[1u8; 32], [2; 32], [4; 32]],
        &msg,
    );
    assert_eq!(wrong, Err(Error::SigPubkey));
    let reordered = check_ed25519_batch(
        &ED25519_PROGRAM_ID,
        &data,
        &[[2u8; 32], [1; 32], [3; 32]],
        &msg,
    );
    assert_eq!(reordered, Err(Error::SigPubkey));
    let dropped = check_ed25519_batch(&ED25519_PROGRAM_ID, &data, &[[1u8; 32], [2; 32]], &msg);
    assert_eq!(dropped, Err(Error::SigHeader));
    let other = offchain_envelope(&[9; 32], &[0x44; 32]);
    assert_eq!(
        check_ed25519_batch(&ED25519_PROGRAM_ID, &data, &keys, &other),
        Err(Error::SigMessage)
    );
    assert_eq!(
        check_ed25519_batch(&[0xaa; 32], &data, &keys, &msg),
        Err(Error::SigProgram)
    );
}

#[test]
fn a_batch_rejects_a_tampered_count_header_or_trailing_bytes() {
    let msg = offchain_envelope(&[9; 32], &[0x33; 32]);
    let keys = [[1u8; 32], [2; 32], [3; 32]];
    assert_eq!(
        check_ed25519_batch(
            &ED25519_PROGRAM_ID,
            &flipped(batch_data(&keys, &msg), 0),
            &keys,
            &msg
        ),
        Err(Error::SigHeader)
    );
    assert_eq!(
        check_ed25519_batch(
            &ED25519_PROGRAM_ID,
            &flipped(batch_data(&keys, &msg), 1),
            &keys,
            &msg
        ),
        Err(Error::SigHeader)
    );
    assert_eq!(
        check_ed25519_batch(
            &ED25519_PROGRAM_ID,
            &flipped(batch_data(&keys, &msg), 2),
            &keys,
            &msg
        ),
        Err(Error::SigHeader)
    );
    let mut longer = batch_data(&keys, &msg);
    longer.push(0);
    assert_eq!(
        check_ed25519_batch(&ED25519_PROGRAM_ID, &longer, &keys, &msg),
        Err(Error::SigHeader)
    );
    assert_eq!(
        check_ed25519_batch(&ED25519_PROGRAM_ID, &[], &keys, &msg),
        Err(Error::SigHeader)
    );
    assert_eq!(
        check_ed25519_batch(&ED25519_PROGRAM_ID, &batch_data(&[], &msg), &[], &msg),
        Err(Error::SigHeader)
    );
}

#[test]
fn a_batch_leaves_the_signature_bytes_to_the_precompile() {
    let msg = offchain_envelope(&[9; 32], &[0x33; 32]);
    let keys = [[1u8; 32], [2; 32]];
    let sigs_at = 14usize
        .saturating_mul(keys.len())
        .saturating_add(2)
        .saturating_add(32usize.saturating_mul(keys.len()));
    assert_eq!(
        check_ed25519_batch(
            &ED25519_PROGRAM_ID,
            &flipped(batch_data(&keys, &msg), sigs_at),
            &keys,
            &msg
        ),
        Ok(())
    );
}

#[test]
fn preimage_lays_out_every_field_at_a_fixed_offset() {
    let params = [9u8; 128];
    let p = SignedIntent {
        program: [1; 32],
        domain: [2; 32],
        owner: [3; 32],
        owner_input: [10; 32],
        input_mint: [4; 32],
        output_mint: [5; 32],
        receiver: [6; 32],
        nonce: 0x0102_0304_0506_0708,
        expires_at: -2,
        submit_by: 0x1122,
        kind: 4,
        flags: 0xa1b2,
        params: &params,
        epoch: 0x0102_0304_0506_0708,
        ext_hash: [7; 32],
        relayer_fee: 0x1112_1314_1516_1718,
    }
    .preimage();
    assert_eq!(p.get(0..16), Some(&INTENT_TAG[..]));
    for (i, fill) in [1u8, 2, 3, 10, 4, 5, 6].iter().enumerate() {
        let at = 16 + i * 32;
        assert_eq!(p.get(at..at + 32), Some(&[*fill; 32][..]), "field {i}");
    }
    assert_eq!(p.get(240..248), Some(&[8, 7, 6, 5, 4, 3, 2, 1][..]));
    assert_eq!(
        p.get(248..256),
        Some(&[0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff][..])
    );
    assert_eq!(p.get(256..264), Some(&[0x22, 0x11, 0, 0, 0, 0, 0, 0][..]));
    assert_eq!(p.get(264..272), Some(&[4, 0xb2, 0xa1, 0, 0, 0, 0, 0][..]));
    assert_eq!(p.get(272..400), Some(&params[..]));
    assert_eq!(p.get(400..408), Some(&[8, 7, 6, 5, 4, 3, 2, 1][..]));
    assert_eq!(p.get(408..440), Some(&[7; 32][..]));
    assert_eq!(
        p.get(440..448),
        Some(&[0x18, 0x17, 0x16, 0x15, 0x14, 0x13, 0x12, 0x11][..])
    );
    assert_eq!(p.len(), 448);
}

#[test]
fn envelope_wraps_the_digest_as_lowercase_hex_for_one_signer() {
    let digest: [u8; 32] = core::array::from_fn(|i| u8::try_from(i * 8 + 3).unwrap_or(0));
    let e = offchain_envelope(&PK, &digest);
    assert_eq!(e.get(0..16), Some(&OFFCHAIN_PREFIX[..]));
    assert_eq!(OFFCHAIN_PREFIX.first(), Some(&0xff));
    assert_eq!(&OFFCHAIN_PREFIX[1..], b"solana offchain");
    assert_eq!(e.get(16..18), Some(&[1, 1][..]));
    assert_eq!(e.get(18..50), Some(&PK[..]));
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(e.get(50..114), Some(hex.as_bytes()));
    assert_eq!(e.len(), 114);
}

#[test]
fn every_hex_digit_renders() {
    let digest: [u8; 32] = core::array::from_fn(|i| u8::try_from(i * 17 % 256).unwrap_or(0));
    let e = offchain_envelope(&PK, &digest);
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(e.get(50..114), Some(hex.as_bytes()));
    for digit in "0123456789abcdef".chars() {
        assert!(hex.contains(digit), "{digit}");
    }
}

#[test]
fn attestation_binds_program_domain_intent_payee_amount_and_result() {
    let m = AttestedFill {
        program: [1; 32],
        domain: [4; 32],
        intent: [2; 32],
        payee: [3; 32],
        amount_in: 0x0506,
        result: 0x0a0b_0c0d,
        filled: 0x1112,
        revision: 0x2122_2324,
        max_fee_bps: 0x3132,
        ext_hash: [7; 32],
    }
    .preimage();
    assert_eq!(m.get(0..16), Some(&ATTEST_TAG[..]));
    assert_eq!(m.get(16..48), Some(&[1; 32][..]));
    assert_eq!(m.get(48..80), Some(&[4; 32][..]));
    assert_eq!(m.get(80..112), Some(&[2; 32][..]));
    assert_eq!(m.get(112..144), Some(&[3; 32][..]));
    assert_eq!(m.get(144..152), Some(&[6, 5, 0, 0, 0, 0, 0, 0][..]));
    assert_eq!(
        m.get(152..160),
        Some(&[0x0d, 0x0c, 0x0b, 0x0a, 0, 0, 0, 0][..])
    );
    assert_eq!(m.get(160..168), Some(&[0x12, 0x11, 0, 0, 0, 0, 0, 0][..]));
    assert_eq!(m.get(168..172), Some(&[0x24, 0x23, 0x22, 0x21][..]));
    assert_eq!(m.get(172..174), Some(&[0x32, 0x31][..]));
    assert_eq!(m.get(174..206), Some(&[7; 32][..]));
    assert_eq!(m.len(), 206);
}

#[test]
fn tags_are_brand_neutral_and_distinct() {
    assert_eq!(&INTENT_TAG, b"intent-engine-v1");
    assert_eq!(&ATTEST_TAG, b"intent-engine-at");
    assert_ne!(INTENT_TAG, ATTEST_TAG);
}

#[test]
fn a_proof_attestation_binds_the_spec_hash_at_the_end_under_a_distinct_tag() {
    let base = AttestedProof {
        program: [1; 32],
        domain: [4; 32],
        intent: [2; 32],
        payee: [3; 32],
        amount_in: 0x0506,
        result: 0x0a0b_0c0d,
        filled: 0x1112,
        revision: 0x2122_2324,
        max_fee_bps: 0x3132,
        ext_hash: [7; 32],
        spec_hash: [8; 32],
    };
    let m = base.preimage();
    assert_eq!(m.len(), 238);
    assert_ne!(ATTEST_PROOF_TAG, ATTEST_TAG);
    assert_eq!(m.get(0..16), Some(&ATTEST_PROOF_TAG[..]));
    assert_eq!(m.get(16..48), Some(&[1; 32][..]));
    assert_eq!(m.get(112..144), Some(&[3; 32][..]));
    assert_eq!(m.get(174..206), Some(&[7; 32][..]));
    assert_eq!(m.get(206..238), Some(&[8; 32][..]));

    let other = AttestedProof {
        spec_hash: [9; 32],
        ..base
    };
    assert_ne!(base.preimage(), other.preimage());
    assert_eq!(base.preimage().get(0..206), other.preimage().get(0..206));
}

#[test]
fn a_proof_attestation_binds_the_payee() {
    let base = AttestedProof {
        program: [1; 32],
        domain: [4; 32],
        intent: [2; 32],
        payee: [3; 32],
        amount_in: 0x0506,
        result: 0x0a0b_0c0d,
        filled: 0x1112,
        revision: 0x2122_2324,
        max_fee_bps: 0x3132,
        ext_hash: [7; 32],
        spec_hash: [8; 32],
    };
    let other = AttestedProof {
        payee: [5; 32],
        ..base
    };
    let b = base.preimage();
    let o = other.preimage();
    assert_ne!(b, o);
    assert_eq!(b[..112], o[..112]);
    assert_eq!(b[144..], o[144..]);
}

#[test]
fn a_proof_attestation_binds_the_amount_in() {
    let base = AttestedProof {
        program: [1; 32],
        domain: [4; 32],
        intent: [2; 32],
        payee: [3; 32],
        amount_in: 0x0506,
        result: 0x0a0b_0c0d,
        filled: 0x1112,
        revision: 0x2122_2324,
        max_fee_bps: 0x3132,
        ext_hash: [7; 32],
        spec_hash: [8; 32],
    };
    let other = AttestedProof {
        amount_in: 0x0809,
        ..base
    };
    let b = base.preimage();
    let o = other.preimage();
    assert_ne!(b, o);
    assert_eq!(b[..144], o[..144]);
    assert_eq!(b[152..], o[152..]);
}

#[test]
fn a_proof_attestation_binds_the_intent() {
    let base = AttestedProof {
        program: [1; 32],
        domain: [4; 32],
        intent: [2; 32],
        payee: [3; 32],
        amount_in: 0x0506,
        result: 0x0a0b_0c0d,
        filled: 0x1112,
        revision: 0x2122_2324,
        max_fee_bps: 0x3132,
        ext_hash: [7; 32],
        spec_hash: [8; 32],
    };
    let other = AttestedProof {
        intent: [9; 32],
        ..base
    };
    let b = base.preimage();
    let o = other.preimage();
    assert_ne!(b, o);
    assert_eq!(b[..80], o[..80]);
    assert_eq!(b[112..], o[112..]);
}

#[test]
fn a_proof_attestation_binds_the_result() {
    let base = AttestedProof {
        program: [1; 32],
        domain: [4; 32],
        intent: [2; 32],
        payee: [3; 32],
        amount_in: 0x0506,
        result: 0x0a0b_0c0d,
        filled: 0x1112,
        revision: 0x2122_2324,
        max_fee_bps: 0x3132,
        ext_hash: [7; 32],
        spec_hash: [8; 32],
    };
    let other = AttestedProof {
        result: 0x1234_5678,
        ..base
    };
    let b = base.preimage();
    let o = other.preimage();
    assert_ne!(b, o);
    assert_eq!(b[..152], o[..152]);
    assert_eq!(b[160..], o[160..]);
}

#[test]
fn a_proof_attestation_binds_the_ext_hash() {
    let base = AttestedProof {
        program: [1; 32],
        domain: [4; 32],
        intent: [2; 32],
        payee: [3; 32],
        amount_in: 0x0506,
        result: 0x0a0b_0c0d,
        filled: 0x1112,
        revision: 0x2122_2324,
        max_fee_bps: 0x3132,
        ext_hash: [7; 32],
        spec_hash: [8; 32],
    };
    let other = AttestedProof {
        ext_hash: [6; 32],
        ..base
    };
    let b = base.preimage();
    let o = other.preimage();
    assert_ne!(b, o);
    assert_eq!(b[..174], o[..174]);
    assert_eq!(b[206..], o[206..]);
}

#[test]
fn a_proof_attestation_binds_the_domain() {
    let base = AttestedProof {
        program: [1; 32],
        domain: [4; 32],
        intent: [2; 32],
        payee: [3; 32],
        amount_in: 0x0506,
        result: 0x0a0b_0c0d,
        filled: 0x1112,
        revision: 0x2122_2324,
        max_fee_bps: 0x3132,
        ext_hash: [7; 32],
        spec_hash: [8; 32],
    };
    let other = AttestedProof {
        domain: [0x55; 32],
        ..base
    };
    let b = base.preimage();
    let o = other.preimage();
    assert_ne!(b, o);
    assert_eq!(b[..48], o[..48]);
    assert_eq!(b[80..], o[80..]);
}

#[test]
fn a_proof_attestation_binds_the_filled() {
    let base = AttestedProof {
        program: [1; 32],
        domain: [4; 32],
        intent: [2; 32],
        payee: [3; 32],
        amount_in: 0x0506,
        result: 0x0a0b_0c0d,
        filled: 0x1112,
        revision: 0x2122_2324,
        max_fee_bps: 0x3132,
        ext_hash: [7; 32],
        spec_hash: [8; 32],
    };
    let other = AttestedProof {
        filled: 0x7777_8888,
        ..base
    };
    let b = base.preimage();
    let o = other.preimage();
    assert_ne!(b, o);
    assert_eq!(b[..160], o[..160]);
    assert_eq!(b[168..], o[168..]);
}

#[test]
fn a_proof_attestation_binds_the_revision() {
    let base = AttestedProof {
        program: [1; 32],
        domain: [4; 32],
        intent: [2; 32],
        payee: [3; 32],
        amount_in: 0x0506,
        result: 0x0a0b_0c0d,
        filled: 0x1112,
        revision: 0x2122_2324,
        max_fee_bps: 0x3132,
        ext_hash: [7; 32],
        spec_hash: [8; 32],
    };
    let other = AttestedProof {
        revision: 0x3333_4444,
        ..base
    };
    let b = base.preimage();
    let o = other.preimage();
    assert_ne!(b, o);
    assert_eq!(b[..168], o[..168]);
    assert_eq!(b[172..], o[172..]);
}

#[test]
fn a_proof_attestation_binds_the_max_fee_bps() {
    let base = AttestedProof {
        program: [1; 32],
        domain: [4; 32],
        intent: [2; 32],
        payee: [3; 32],
        amount_in: 0x0506,
        result: 0x0a0b_0c0d,
        filled: 0x1112,
        revision: 0x2122_2324,
        max_fee_bps: 0x3132,
        ext_hash: [7; 32],
        spec_hash: [8; 32],
    };
    let other = AttestedProof {
        max_fee_bps: 0x4546,
        ..base
    };
    let b = base.preimage();
    let o = other.preimage();
    assert_ne!(b, o);
    assert_eq!(b[..172], o[..172]);
    assert_eq!(b[174..], o[174..]);
}

#[test]
fn a_signature_check_pins_the_ed25519_precompile_id() {
    assert_eq!(
        ED25519_PROGRAM_ID,
        [
            3, 125, 70, 214, 124, 147, 251, 190, 18, 249, 66, 143, 131, 141, 64, 255, 5, 112, 116,
            73, 39, 244, 138, 100, 252, 202, 112, 68, 128, 0, 0, 0,
        ]
    );
}

#[test]
fn a_non_attested_intent_has_no_proof_spec_or_judge_fee() {
    let non_attested = [
        intent_core::kinds::Intent::SwapExactIn(intent_core::kinds::swap_exact_in::Params {
            amount_in: 1,
            min_out: 1,
        }),
        intent_core::kinds::Intent::LimitOrder(intent_core::kinds::limit_order::Params {
            make_amount: 1,
            take_amount: 1,
        }),
        intent_core::kinds::Intent::DutchAuction(intent_core::kinds::dutch_auction::Params {
            amount_in: 1,
            start_out: 2,
            end_out: 1,
            start_ts: 0,
            end_ts: 1,
        }),
    ];
    for intent in non_attested {
        assert_eq!(intent.spec_hash(), [0u8; 32]);
        assert_eq!(intent.judge_fee(), 0);
    }
}

#[test]
fn a_split_attestation_lays_out_every_field_and_binds_the_split_hash_under_a_distinct_tag() {
    let base = AttestedSplit {
        program: [1; 32],
        domain: [4; 32],
        intent: [2; 32],
        amount_in: 0x0506,
        result: 0x0a0b_0c0d,
        filled: 0x1112,
        revision: 0x2122_2324,
        max_fee_bps: 0x3132,
        ext_hash: [6; 32],
        spec_hash: [7; 32],
        split_hash: [8; 32],
    };
    let m = base.preimage();
    assert_eq!(m.len(), 238);
    assert_ne!(ATTEST_SPLIT_TAG, ATTEST_PROOF_TAG);
    assert_ne!(ATTEST_SPLIT_TAG, ATTEST_TAG);
    assert_eq!(m.get(0..16), Some(&ATTEST_SPLIT_TAG[..]));
    assert_eq!(m.get(16..48), Some(&[1; 32][..]));
    assert_eq!(m.get(48..80), Some(&[4; 32][..]));
    assert_eq!(m.get(80..112), Some(&[2; 32][..]));
    assert_eq!(m.get(112..120), Some(&0x0506u64.to_le_bytes()[..]));
    assert_eq!(m.get(120..128), Some(&0x0a0b_0c0du64.to_le_bytes()[..]));
    assert_eq!(m.get(128..136), Some(&0x1112u64.to_le_bytes()[..]));
    assert_eq!(m.get(136..140), Some(&0x2122_2324u32.to_le_bytes()[..]));
    assert_eq!(m.get(140..142), Some(&0x3132u16.to_le_bytes()[..]));
    assert_eq!(m.get(142..174), Some(&[6; 32][..]));
    assert_eq!(m.get(174..206), Some(&[7; 32][..]));
    assert_eq!(m.get(206..238), Some(&[8; 32][..]));
}

#[test]
fn a_split_attestation_changes_only_the_tail_when_the_split_hash_changes() {
    let base = AttestedSplit {
        program: [1; 32],
        domain: [4; 32],
        intent: [2; 32],
        amount_in: 0x0506,
        result: 0x0a0b_0c0d,
        filled: 0x1112,
        revision: 0x2122_2324,
        max_fee_bps: 0x3132,
        ext_hash: [6; 32],
        spec_hash: [7; 32],
        split_hash: [8; 32],
    };
    let other = AttestedSplit {
        split_hash: [9; 32],
        ..base
    };
    assert_ne!(base.preimage(), other.preimage());
    assert_eq!(base.preimage().get(0..206), other.preimage().get(0..206));
}
