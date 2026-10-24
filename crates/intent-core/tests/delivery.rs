use intent_core::claim::Slot;
use intent_core::delivery::{
    blob_head, closable, commitment_preimage, fingerprint_preimage, may_announce, refutes,
    split_hash_preimage, AnnState, BlobHead, BLOB_FIXED_LEN, BLOB_PER_RECIPIENT_LEN, BLOB_VERSION,
    COMMITMENT_TAG, FINGERPRINT_TAG, MAX_BLOB_RECIPIENTS, MAX_BLOB_URL, MAX_SEALED_BLOB,
    MAX_SPLIT_RECIPIENTS, REFUTE_WINDOW_SECS,
};
use intent_core::sig::{
    AttestedDelivery, AttestedSplitDelivery, ATTEST_DELIVERY_PREIMAGE_LEN, ATTEST_DELIVERY_TAG,
    ATTEST_SPLIT_DELIVERY_PREIMAGE_LEN, ATTEST_SPLIT_DELIVERY_TAG,
};
use intent_core::Error;

const INTENT: [u8; 32] = [1; 32];
const WORKER: [u8; 32] = [2; 32];
const OTHER: [u8; 32] = [3; 32];
const SALT: [u8; 16] = [4; 16];
const SHA: [u8; 32] = [5; 32];

fn blob(count: u8, mask: u8, url: usize) -> Vec<u8> {
    let mut bytes = vec![BLOB_VERSION, count, mask];
    for i in 0..count {
        bytes.extend_from_slice(&[i.wrapping_add(10); 8]);
    }
    let per = BLOB_PER_RECIPIENT_LEN
        .saturating_sub(8)
        .saturating_mul(usize::from(count));
    let rest = BLOB_FIXED_LEN
        .saturating_sub(3)
        .saturating_add(per)
        .saturating_add(url);
    bytes.extend(core::iter::repeat_n(0xab, rest));
    bytes
}

#[test]
fn commitment_preimage_is_tag_intent_worker_salt_sha256() {
    let p = commitment_preimage(&INTENT, &WORKER, &SALT, &SHA);
    assert_eq!(COMMITMENT_TAG, *b"intent-engine-dc");
    assert_eq!(p.len(), 128);
    assert_eq!(p[..16], COMMITMENT_TAG);
    assert_eq!(p[16..48], INTENT);
    assert_eq!(p[48..80], WORKER);
    assert_eq!(p[80..96], SALT);
    assert_eq!(p[96..128], SHA);
    let other = commitment_preimage(&INTENT, &OTHER, &SALT, &SHA);
    assert_ne!(p, other);
}

#[test]
fn commitment_preimage_binds_the_whole_sha256() {
    let mut sha = SHA;
    if let Some(last) = sha.last_mut() {
        *last ^= 1;
    }
    assert_ne!(
        commitment_preimage(&INTENT, &WORKER, &SALT, &SHA),
        commitment_preimage(&INTENT, &WORKER, &SALT, &sha)
    );
}

#[test]
fn fingerprint_preimage_is_tag_and_key() {
    let p = fingerprint_preimage(&[9; 32]);
    assert_eq!(FINGERPRINT_TAG, *b"intent-engine-fp");
    assert_eq!(p.len(), 48);
    assert_eq!(p[..16], FINGERPRINT_TAG);
    assert_eq!(p[16..], [9; 32]);
}

#[test]
fn blob_bounds_fit_a_full_committee_with_the_longest_url() {
    assert_eq!(BLOB_FIXED_LEN, 99);
    assert_eq!(BLOB_PER_RECIPIENT_LEN, 40);
    assert_eq!(MAX_BLOB_RECIPIENTS, 8);
    assert_eq!(MAX_BLOB_URL, 200);
    assert_eq!(MAX_SEALED_BLOB, 624);
    let longest = BLOB_FIXED_LEN + BLOB_PER_RECIPIENT_LEN * MAX_BLOB_RECIPIENTS + MAX_BLOB_URL;
    assert!(longest <= MAX_SEALED_BLOB);
}

#[test]
fn blob_head_reads_count_mask_fingerprints_and_url_length() {
    let mut fps = [[0u8; 8]; MAX_BLOB_RECIPIENTS];
    fps[0] = [10; 8];
    fps[1] = [11; 8];
    fps[2] = [12; 8];
    assert_eq!(
        blob_head(&blob(3, 0b101, 42)),
        Ok(BlobHead {
            count: 3,
            mask: 0b101,
            fps,
            url_len: 42
        })
    );
    assert!(blob_head(&blob(1, 0, 1)).is_ok());
    assert!(blob_head(&blob(8, 0xff, MAX_BLOB_URL)).is_ok());
}

#[test]
fn blob_head_refuses_every_malformed_shape() {
    let mut old = blob(1, 1, 10);
    if let Some(version) = old.first_mut() {
        *version = 3;
    }
    let cases: Vec<Vec<u8>> = vec![
        Vec::new(),
        vec![BLOB_VERSION, 1],
        old,
        blob(0, 0, 10),
        blob(9, 0, 10),
        blob(2, 0b100, 10),
        blob(1, 0b10, 10),
        blob(1, 0, 0),
        blob(1, 0, MAX_BLOB_URL + 1),
        blob(8, 0, MAX_BLOB_URL + 6),
    ];
    for (i, bytes) in cases.iter().enumerate() {
        assert_eq!(
            blob_head(bytes).err(),
            Some(Error::BlobMalformed),
            "case {i}"
        );
    }
    let mut short = blob(2, 0, 10);
    short.truncate(3 + 8 + 4);
    assert_eq!(blob_head(&short).err(), Some(Error::BlobMalformed));
}

#[test]
fn only_the_holder_announces_while_a_claim_is_held() {
    assert!(may_announce(Slot::Free, WORKER).is_ok());
    assert!(may_announce(Slot::Lapsed { worker: OTHER }, WORKER).is_ok());
    assert!(may_announce(
        Slot::Held {
            worker: WORKER,
            until: 9
        },
        WORKER
    )
    .is_ok());
    assert_eq!(
        may_announce(
            Slot::Held {
                worker: OTHER,
                until: 9
            },
            WORKER
        ),
        Err(Error::ClaimHeld)
    );
}

#[test]
fn announcement_states_decode_and_refuse_unknown_bytes() {
    assert_eq!(AnnState::try_from(0u8), Ok(AnnState::Announced));
    assert_eq!(AnnState::try_from(1u8), Ok(AnnState::Paid));
    assert_eq!(AnnState::try_from(2u8), Err(Error::AnnouncementState));
    assert_eq!(u8::from(AnnState::Announced), 0);
    assert_eq!(u8::from(AnnState::Paid), 1);
}

#[test]
fn an_unpaid_announcement_closes_for_its_worker_once_the_intent_stops_being_open() {
    let (expires, now) = (1_000, 500);
    assert_eq!(
        closable(AnnState::Announced, true, true, now, expires, 0),
        Err(Error::AnnouncementOpen)
    );
    assert_eq!(
        closable(AnnState::Announced, true, false, now, expires, 0),
        Ok(())
    );
}

#[test]
fn others_close_an_unpaid_announcement_only_after_the_refute_window() {
    let expires = 1_000;
    let edge = expires + REFUTE_WINDOW_SECS;
    assert_eq!(REFUTE_WINDOW_SECS, 30 * 86_400);
    assert_eq!(
        closable(AnnState::Announced, false, false, edge - 1, expires, 0),
        Err(Error::AnnouncementRetained)
    );
    assert_eq!(
        closable(AnnState::Announced, false, false, edge, expires, 0),
        Ok(())
    );
}

#[test]
fn a_paid_announcement_closes_for_anyone_only_after_the_refute_window() {
    let paid = 2_000;
    let edge = paid + REFUTE_WINDOW_SECS;
    for by_worker in [true, false] {
        assert_eq!(
            closable(AnnState::Paid, by_worker, false, edge - 1, 1_000, paid),
            Err(Error::AnnouncementRetained)
        );
        assert_eq!(
            closable(AnnState::Paid, by_worker, false, edge, 1_000, paid),
            Ok(())
        );
    }
}

#[test]
fn closing_never_overflows_at_the_edge_of_time() {
    assert_eq!(
        closable(AnnState::Announced, false, false, i64::MAX, i64::MAX, 0),
        Err(Error::Overflow)
    );
    assert_eq!(
        closable(AnnState::Paid, false, false, i64::MAX, 0, i64::MAX),
        Err(Error::Overflow)
    );
}

#[test]
fn a_refutation_needs_an_earlier_seq_from_a_wallet_that_was_not_paid() {
    assert_eq!(refutes(1, 2, OTHER, &[WORKER]), Ok(()));
    assert_eq!(
        refutes(2, 2, OTHER, &[WORKER]),
        Err(Error::RefuteNotEarlier)
    );
    assert_eq!(
        refutes(3, 2, OTHER, &[WORKER]),
        Err(Error::RefuteNotEarlier)
    );
    assert_eq!(
        refutes(1, 2, WORKER, &[WORKER]),
        Err(Error::RefuteSamePayee)
    );
    assert_eq!(
        refutes(1, 2, OTHER, &[WORKER, OTHER]),
        Err(Error::RefuteSamePayee)
    );
}

#[test]
fn split_hash_preimage_lists_each_wallet_with_its_weight() {
    let mut expected = [0u8; 34 * MAX_SPLIT_RECIPIENTS];
    expected[..32].copy_from_slice(&WORKER);
    expected[32..34].copy_from_slice(&7_000u16.to_le_bytes());
    expected[34..66].copy_from_slice(&OTHER);
    expected[66..68].copy_from_slice(&3_000u16.to_le_bytes());
    assert_eq!(
        split_hash_preimage(&[WORKER, OTHER], &[7_000, 3_000]),
        Ok((expected, 68))
    );
    assert_eq!(MAX_SPLIT_RECIPIENTS, 8);
}

#[test]
fn split_hash_preimage_refuses_bad_counts() {
    assert_eq!(
        split_hash_preimage(&[], &[]).err(),
        Some(Error::SplitCountMismatch)
    );
    assert_eq!(
        split_hash_preimage(&[WORKER], &[1, 2]).err(),
        Some(Error::SplitCountMismatch)
    );
    let nine = [WORKER; 9];
    assert_eq!(
        split_hash_preimage(&nine, &[1; 9]).err(),
        Some(Error::SplitCountMismatch)
    );
}

fn delivery() -> AttestedDelivery {
    AttestedDelivery {
        program: [11; 32],
        domain: [12; 32],
        intent: [13; 32],
        payee: [14; 32],
        amount_in: 0x0102_0304_0506_0708,
        result: 2,
        filled: 3,
        revision: 4,
        max_fee_bps: 5,
        ext_hash: [15; 32],
        spec_hash: [16; 32],
        announcement: [17; 32],
        seq: 0x1122_3344_5566_7788,
        delivered: [18; 32],
        salt: [19; 16],
    }
}

#[test]
fn attested_delivery_preimage_binds_the_announcement_seq_and_opening() {
    let p = delivery().preimage();
    assert_eq!(ATTEST_DELIVERY_TAG, *b"intent-engine-dl");
    assert_eq!(ATTEST_DELIVERY_PREIMAGE_LEN, 326);
    assert_eq!(p.len(), ATTEST_DELIVERY_PREIMAGE_LEN);
    assert_eq!(p[..16], ATTEST_DELIVERY_TAG);
    assert_eq!(p[16..48], [11; 32]);
    assert_eq!(p[48..80], [12; 32]);
    assert_eq!(p[80..112], [13; 32]);
    assert_eq!(p[112..144], [14; 32]);
    assert_eq!(p[144..152], 0x0102_0304_0506_0708u64.to_le_bytes());
    assert_eq!(p[152..160], 2u64.to_le_bytes());
    assert_eq!(p[160..168], 3u64.to_le_bytes());
    assert_eq!(p[168..172], 4u32.to_le_bytes());
    assert_eq!(p[172..174], 5u16.to_le_bytes());
    assert_eq!(p[174..206], [15; 32]);
    assert_eq!(p[206..238], [16; 32]);
    assert_eq!(p[238..270], [17; 32]);
    assert_eq!(p[270..278], 0x1122_3344_5566_7788u64.to_le_bytes());
    assert_eq!(p[278..310], [18; 32]);
    assert_eq!(p[310..326], [19; 16]);
}

#[test]
fn attested_delivery_preimage_changes_with_each_bound_field() {
    let base = delivery().preimage();
    let variants = [
        AttestedDelivery {
            program: [0; 32],
            ..delivery()
        },
        AttestedDelivery {
            domain: [0; 32],
            ..delivery()
        },
        AttestedDelivery {
            intent: [0; 32],
            ..delivery()
        },
        AttestedDelivery {
            payee: [0; 32],
            ..delivery()
        },
        AttestedDelivery {
            amount_in: 1,
            ..delivery()
        },
        AttestedDelivery {
            result: 1,
            ..delivery()
        },
        AttestedDelivery {
            filled: 1,
            ..delivery()
        },
        AttestedDelivery {
            revision: 1,
            ..delivery()
        },
        AttestedDelivery {
            max_fee_bps: 1,
            ..delivery()
        },
        AttestedDelivery {
            ext_hash: [0; 32],
            ..delivery()
        },
        AttestedDelivery {
            spec_hash: [0; 32],
            ..delivery()
        },
        AttestedDelivery {
            announcement: [0; 32],
            ..delivery()
        },
        AttestedDelivery {
            seq: 1,
            ..delivery()
        },
        AttestedDelivery {
            delivered: [0; 32],
            ..delivery()
        },
        AttestedDelivery {
            salt: [0; 16],
            ..delivery()
        },
    ];
    for v in variants {
        assert_ne!(v.preimage(), base);
    }
}

fn split_delivery() -> AttestedSplitDelivery {
    AttestedSplitDelivery {
        program: [11; 32],
        domain: [12; 32],
        intent: [13; 32],
        amount_in: 0x0102_0304_0506_0708,
        result: 2,
        filled: 3,
        revision: 4,
        max_fee_bps: 5,
        ext_hash: [15; 32],
        spec_hash: [16; 32],
        split_hash: [20; 32],
        announcement: [17; 32],
        seq: 0x1122_3344_5566_7788,
        delivered: [18; 32],
        salt: [19; 16],
    }
}

#[test]
fn attested_split_delivery_preimage_extends_the_split_fields() {
    let p = split_delivery().preimage();
    assert_eq!(ATTEST_SPLIT_DELIVERY_TAG, *b"intent-engine-sd");
    assert_eq!(ATTEST_SPLIT_DELIVERY_PREIMAGE_LEN, 326);
    assert_eq!(p.len(), ATTEST_SPLIT_DELIVERY_PREIMAGE_LEN);
    assert_eq!(p[..16], ATTEST_SPLIT_DELIVERY_TAG);
    assert_eq!(p[16..48], [11; 32]);
    assert_eq!(p[48..80], [12; 32]);
    assert_eq!(p[80..112], [13; 32]);
    assert_eq!(p[112..120], 0x0102_0304_0506_0708u64.to_le_bytes());
    assert_eq!(p[120..128], 2u64.to_le_bytes());
    assert_eq!(p[128..136], 3u64.to_le_bytes());
    assert_eq!(p[136..140], 4u32.to_le_bytes());
    assert_eq!(p[140..142], 5u16.to_le_bytes());
    assert_eq!(p[142..174], [15; 32]);
    assert_eq!(p[174..206], [16; 32]);
    assert_eq!(p[206..238], [20; 32]);
    assert_eq!(p[238..270], [17; 32]);
    assert_eq!(p[270..278], 0x1122_3344_5566_7788u64.to_le_bytes());
    assert_eq!(p[278..310], [18; 32]);
    assert_eq!(p[310..326], [19; 16]);
}

#[test]
fn attested_split_delivery_preimage_changes_with_each_bound_field() {
    let base = split_delivery().preimage();
    let variants = [
        AttestedSplitDelivery {
            program: [0; 32],
            ..split_delivery()
        },
        AttestedSplitDelivery {
            domain: [0; 32],
            ..split_delivery()
        },
        AttestedSplitDelivery {
            intent: [0; 32],
            ..split_delivery()
        },
        AttestedSplitDelivery {
            amount_in: 1,
            ..split_delivery()
        },
        AttestedSplitDelivery {
            result: 1,
            ..split_delivery()
        },
        AttestedSplitDelivery {
            filled: 1,
            ..split_delivery()
        },
        AttestedSplitDelivery {
            revision: 1,
            ..split_delivery()
        },
        AttestedSplitDelivery {
            max_fee_bps: 1,
            ..split_delivery()
        },
        AttestedSplitDelivery {
            ext_hash: [0; 32],
            ..split_delivery()
        },
        AttestedSplitDelivery {
            spec_hash: [0; 32],
            ..split_delivery()
        },
        AttestedSplitDelivery {
            split_hash: [0; 32],
            ..split_delivery()
        },
        AttestedSplitDelivery {
            announcement: [0; 32],
            ..split_delivery()
        },
        AttestedSplitDelivery {
            seq: 1,
            ..split_delivery()
        },
        AttestedSplitDelivery {
            delivered: [0; 32],
            ..split_delivery()
        },
        AttestedSplitDelivery {
            salt: [0; 16],
            ..split_delivery()
        },
    ];
    for v in variants {
        assert_ne!(v.preimage(), base);
    }
}

#[test]
fn every_domain_tag_in_core_is_unique() {
    use intent_core::committee::{COMMITTEE_COSIGN_TAG, COMMITTEE_TAG};
    use intent_core::sig::{ATTEST_TAG, INTENT_TAG, RETIRED_TAGS, SPLIT_COSIGN_TAG};
    assert_eq!(RETIRED_TAGS, [*b"intent-engine-pf", *b"intent-engine-sp"]);
    let [retired_proof, retired_split] = RETIRED_TAGS;
    let tags: [&[u8]; 11] = [
        &INTENT_TAG,
        &ATTEST_TAG,
        &retired_proof,
        &retired_split,
        &ATTEST_DELIVERY_TAG,
        &ATTEST_SPLIT_DELIVERY_TAG,
        &SPLIT_COSIGN_TAG,
        &COMMITTEE_TAG,
        &COMMITTEE_COSIGN_TAG,
        &COMMITMENT_TAG,
        &FINGERPRINT_TAG,
    ];
    for (i, a) in tags.iter().enumerate() {
        for b in tags.iter().skip(i.saturating_add(1)) {
            assert_ne!(a, b);
        }
    }
}
