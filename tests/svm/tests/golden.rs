use intent_engine::events as ev;
use std::path::PathBuf;

use anchor_lang::prelude::Pubkey;
use anchor_lang::{Discriminator, InstructionData};
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use intent_core::fee::split_fee;
use intent_core::kinds::{
    attested_result, dutch_auction, limit_order, swap_exact_in, Intent, Kind, ALL_KINDS_MASK,
};
use intent_core::math::{mul_div_ceil, mul_div_floor};
use intent_core::sig::{
    check_ed25519_ix, offchain_envelope, AttestedFill, AttestedProof, SignedIntent,
    ED25519_PROGRAM_ID,
};
use intent_core::PARAMS_LEN;
use intent_engine::instruction as ix;
use serde_json::{json, Value};
use svm_tests::{config_pda, event_authority, intent_pda, user_pda, vault_pda, TestResult};

const GOLDEN_EXT: [u8; 5] = [1, 2, 0, 0xaa, 0xbb];
const RANDOM_SIGNED: usize = 64;

struct SplitMix(u64);

impl SplitMix {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn bytes<const N: usize>(&mut self) -> [u8; N] {
        let mut out = [0u8; N];
        for chunk in out.chunks_mut(8) {
            let word = self.next().to_le_bytes();
            chunk.copy_from_slice(word.get(..chunk.len()).unwrap_or_default());
        }
        out
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next().checked_rem(n).unwrap_or(0)
    }
}

const RANDOM_MATH: usize = 200;

fn spread(r: &mut SplitMix) -> u64 {
    match r.below(4) {
        0 => r.next(),
        1 => r.below(1_000_000),
        2 => r.below(20),
        _ => u64::MAX.saturating_sub(r.below(1_000)),
    }
}

fn bps(r: &mut SplitMix) -> u16 {
    u16::try_from(r.below(10_002)).unwrap_or(0)
}

fn random_three_way() -> Vec<(u64, u16, u16, u16)> {
    let mut r = SplitMix(0x0fee_5eed_0001);
    (0..RANDOM_MATH)
        .map(|_| (spread(&mut r), bps(&mut r), bps(&mut r), bps(&mut r)))
        .collect()
}

fn random_mul_div() -> Vec<(u64, u64, u64)> {
    let mut r = SplitMix(0x0d1f_5eed_0002);
    (0..RANDOM_MATH)
        .map(|_| {
            let d = if r.below(8) == 0 { 0 } else { spread(&mut r) };
            (spread(&mut r), spread(&mut r), d)
        })
        .collect()
}

fn random_dutch() -> Vec<Value> {
    let mut r = SplitMix(0xd07c_5eed_0003);
    (0..RANDOM_MATH)
        .map(|_| {
            let start_out = spread(&mut r);
            let end_out = r.below(start_out.saturating_add(1));
            let start_ts = i64::from_le_bytes(r.bytes()) / 2;
            let span = i64::try_from(r.below(1 << 40))
                .unwrap_or(0)
                .saturating_add(1);
            let end_ts = start_ts.saturating_add(span);
            let amount_in = spread(&mut r).max(1);
            let now = match r.below(4) {
                0 => start_ts.saturating_add(
                    i64::try_from(r.below(u64::try_from(span).unwrap_or(1))).unwrap_or(0),
                ),
                1 => start_ts.saturating_sub(1),
                2 => end_ts,
                _ => i64::from_le_bytes(r.bytes()),
            };
            let intent = Intent::DutchAuction(dutch_auction::Params {
                amount_in,
                start_out,
                end_out,
                start_ts,
                end_ts,
            });
            let asked = if r.below(5) == 0 {
                amount_in.saturating_sub(1)
            } else {
                amount_in
            };
            json!({
                "amount_in": amount_in.to_string(),
                "start_out": start_out.to_string(),
                "end_out": end_out.to_string(),
                "start_ts": start_ts.to_string(),
                "end_ts": end_ts.to_string(),
                "asked": asked.to_string(),
                "now": now.to_string(),
                "result": outcome(intent.required_out(asked, now)),
            })
        })
        .collect()
}

fn random_signed() -> Vec<Value> {
    let mut r = SplitMix(0x5eed_0f51_6eed);
    (0..RANDOM_SIGNED)
        .map(|_| {
            let params: [u8; PARAMS_LEN] = r.bytes();
            let ext_len = usize::try_from(r.below(65)).unwrap_or(0);
            let ext: Vec<u8> = r.bytes::<64>().get(..ext_len).unwrap_or_default().to_vec();
            let owner = Pubkey::new_from_array(r.bytes());
            let signed = SignedIntent {
                program: intent_engine::ID.to_bytes(),
                domain: r.bytes(),
                owner: owner.to_bytes(),
                owner_input: r.bytes(),
                input_mint: r.bytes(),
                output_mint: r.bytes(),
                receiver: r.bytes(),
                nonce: r.next(),
                expires_at: i64::from_le_bytes(r.bytes()),
                submit_by: i64::from_le_bytes(r.bytes()),
                kind: u8::try_from(r.below(256)).unwrap_or(0),
                flags: u16::try_from(r.below(65_536)).unwrap_or(0),
                params: &params,
                epoch: r.next(),
                ext_hash: solana_sha256_hasher::hashv(&[&ext]).to_bytes(),
                relayer_fee: r.next(),
            };
            let preimage = signed.preimage();
            let digest = solana_sha256_hasher::hashv(&[&preimage]).to_bytes();
            let key = |bytes: [u8; 32]| Pubkey::new_from_array(bytes).to_string();
            json!({
                "domain": hex(&signed.domain),
                "owner": owner.to_string(),
                "owner_input": key(signed.owner_input),
                "input_mint": key(signed.input_mint),
                "output_mint": key(signed.output_mint),
                "receiver": key(signed.receiver),
                "nonce": signed.nonce.to_string(),
                "expires_at": signed.expires_at.to_string(),
                "submit_by": signed.submit_by.to_string(),
                "kind": signed.kind,
                "flags": signed.flags,
                "params": hex(&params),
                "epoch": signed.epoch.to_string(),
                "ext": hex(&ext),
                "relayer_fee": signed.relayer_fee.to_string(),
                "preimage": hex(&preimage),
                "digest": hex(&digest),
                "envelope": hex(&offchain_envelope(&owner.to_bytes(), &digest)),
            })
        })
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn key(fill: u8) -> Pubkey {
    Pubkey::new_from_array([fill; 32])
}

fn outcome<T: ToString, E: core::fmt::Debug>(r: Result<T, E>) -> Value {
    match r {
        Ok(v) => json!({ "ok": v.to_string() }),
        Err(e) => json!({ "err": format!("{e:?}") }),
    }
}

fn with_byte(mut bytes: [u8; PARAMS_LEN], at: usize, v: u8) -> [u8; PARAMS_LEN] {
    if let Some(b) = bytes.get_mut(at) {
        *b = v;
    }
    bytes
}

fn limit(make_amount: u64, take_amount: u64) -> TestResult<[u8; PARAMS_LEN]> {
    Ok(limit_order::Params {
        make_amount,
        take_amount,
    }
    .encode()
    .map_err(|e| format!("{e:?}"))?)
}

fn dutch(start_out: u64, end_out: u64, start_ts: i64, end_ts: i64) -> TestResult<[u8; PARAMS_LEN]> {
    Ok(dutch_auction::Params {
        amount_in: 9,
        start_out,
        end_out,
        start_ts,
        end_ts,
    }
    .encode()
    .map_err(|e| format!("{e:?}"))?)
}

fn intents() -> TestResult<Vec<(&'static str, Intent)>> {
    Ok(vec![
        (
            "swap",
            Intent::SwapExactIn(swap_exact_in::Params {
                amount_in: 1_000_000,
                min_out: 990_000,
            }),
        ),
        (
            "limit",
            Intent::LimitOrder(limit_order::Params {
                make_amount: 5_000,
                take_amount: 12_345,
            }),
        ),
        (
            "dutch",
            Intent::DutchAuction(dutch_auction::Params {
                amount_in: 7_777,
                start_out: 10_000,
                end_out: 4_000,
                start_ts: 1_700_000_000,
                end_ts: 1_700_003_600,
            }),
        ),
        (
            "attested",
            Intent::AttestedResult(attested_result::Params {
                amount_in: 3_333,
                min_result: 10,
                max_result: 20,
                attestor: [5; 32],
                spec_hash: [0; 32],
                judge_fee: 0,
            }),
        ),
        (
            "extremes",
            Intent::DutchAuction(dutch_auction::Params {
                amount_in: u64::MAX,
                start_out: u64::MAX,
                end_out: 1,
                start_ts: i64::MIN,
                end_ts: i64::MAX,
            }),
        ),
    ])
}

fn vectors() -> TestResult<Value> {
    let owner = key(1);
    let input_mint = key(2);
    let output_mint = key(3);
    let fee_recipient = key(4);

    let mut pdas = vec![
        json!({ "name": "config", "address": config_pda().to_string() }),
        json!({ "name": "user", "owner": owner.to_string(), "address": user_pda(&owner).to_string() }),
        json!({ "name": "event_authority", "address": event_authority().to_string() }),
    ];
    for nonce in [0u64, 1, 42, u64::MAX] {
        let intent = intent_pda(&owner, nonce);
        pdas.push(json!({
            "name": "intent",
            "owner": owner.to_string(),
            "nonce": nonce.to_string(),
            "address": intent.to_string(),
            "vault": vault_pda(&intent).to_string(),
        }));
    }
    for id in [0u64, 7, u64::MAX] {
        pdas.push(json!({
            "name": "mandate",
            "owner": owner.to_string(),
            "agent": key(0x0a).to_string(),
            "id": id.to_string(),
            "address": svm_tests::mandate_pda(&owner, &key(0x0a), id).to_string(),
        }));
    }
    let atas: Vec<Value> = [anchor_spl::token::ID, anchor_spl::token_2022::ID]
        .iter()
        .map(|program| {
            json!({
                "owner": fee_recipient.to_string(),
                "mint": input_mint.to_string(),
                "token_program": program.to_string(),
                "address": get_associated_token_address_with_program_id(
                    &fee_recipient,
                    &input_mint,
                    program
                )
                .to_string(),
            })
        })
        .collect();

    let mut params = Vec::new();
    let mut required = Vec::new();
    for (name, intent) in intents()? {
        let bytes = intent.encode().map_err(|e| format!("{e:?}"))?;
        params.push(json!({
            "name": name,
            "kind": (intent.kind() as u8).to_string(),
            "hex": hex(&bytes),
            "escrow": intent.escrow_amount().to_string(),
        }));
        let samples: Vec<(u64, i64)> = match intent {
            Intent::SwapExactIn(p) => vec![(p.amount_in, 0), (p.amount_in.saturating_sub(1), 0)],
            Intent::LimitOrder(p) => vec![
                (p.make_amount, 0),
                (1, 0),
                (2_500, 0),
                (0, 0),
                (p.make_amount.saturating_add(1), 0),
            ],
            Intent::AttestedResult(p) => vec![(p.amount_in, 0)],
            Intent::DutchAuction(p) => vec![
                (p.amount_in, i64::MIN),
                (p.amount_in, p.start_ts.saturating_sub(1)),
                (p.amount_in, p.start_ts),
                (p.amount_in, p.start_ts.saturating_add(1)),
                (p.amount_in, p.start_ts.saturating_add(1_800)),
                (p.amount_in, 0),
                (p.amount_in, p.end_ts.saturating_sub(1)),
                (p.amount_in, p.end_ts),
                (p.amount_in, i64::MAX),
                (p.amount_in.saturating_sub(1), p.start_ts),
            ],
        };
        for (amount_in, now) in samples {
            required.push(json!({
                "name": name,
                "amount_in": amount_in.to_string(),
                "now": now.to_string(),
                "result": outcome(intent.required_out(amount_in, now)),
            }));
        }
    }

    let swap_ok = swap_exact_in::Params {
        amount_in: 5,
        min_out: 6,
    }
    .encode()
    .map_err(|e| format!("{e:?}"))?;
    let decode_cases: Vec<(u8, [u8; PARAMS_LEN])> = vec![
        (1, swap_ok),
        (1, with_byte(swap_ok, 16, 1)),
        (1, with_byte(swap_ok, PARAMS_LEN.saturating_sub(1), 0x80)),
        (1, [0; PARAMS_LEN]),
        (2, [0; PARAMS_LEN]),
        (3, [0; PARAMS_LEN]),
        (0, swap_ok),
        (4, swap_ok),
        (2, swap_ok),
        (3, with_byte([0; PARAMS_LEN], 0, 1)),
        (2, limit(0, 5)?),
        (2, limit(5, 0)?),
        (3, dutch(7, 7, 10, 20)?),
        (3, dutch(6, 7, 10, 20)?),
        (3, dutch(7, 7, 20, 20)?),
        (3, dutch(7, 7, 21, 20)?),
        (3, dutch(7, 0, 10, 20)?),
    ];
    let decodes: Vec<Value> = decode_cases
        .iter()
        .map(|(kind, bytes)| {
            json!({
                "kind": kind.to_string(),
                "hex": hex(bytes),
                "result": match Intent::decode(*kind, bytes) {
                    Ok(i) => json!({ "ok": hex(&i.encode().unwrap_or([0; PARAMS_LEN])) }),
                    Err(e) => json!({ "err": format!("{e:?}") }),
                },
            })
        })
        .collect();

    let three_way: Vec<Value> = [
        (0u64, 0u16, 0u16, 0u16),
        (2, 1, 1, 10_000),
        (400, 5, 25, 2_000),
        (10_000, 0, 30, 3_333),
        (10_001, 0, 1, 10_000),
        (100_000, 5, 50, 2_000),
        (u64::MAX, 100, 100, 10_000),
        (1, 1, 1, 0),
        (10_000, 0, 100, 20_000),
        (100, 5_000, 5_001, 0),
        (u64::MAX, 10_000, 0, 0),
        (u64::MAX, 10_000, 10_000, 10_000),
    ]
    .into_iter()
    .chain(random_three_way())
    .collect::<Vec<_>>()
    .iter()
    .map(|(amount, fee, partner, cut)| {
        json!({
            "amount": amount.to_string(),
            "fee_bps": fee.to_string(),
            "partner_bps": partner.to_string(),
            "cut_bps": cut.to_string(),
            "result": match intent_core::fee::split_fees(*amount, *fee, *partner, *cut) {
                Ok(f) => json!({
                    "protocol": f.protocol.to_string(),
                    "partner": f.partner.to_string(),
                    "net": f.net.to_string(),
                }),
                Err(e) => json!({ "err": format!("{e:?}") }),
            },
        })
    })
    .collect();
    let partner_entry = |key: [u8; 32], bps: u16| -> Vec<u8> {
        [&[1u8, 34, 0][..], &key[..], &bps.to_le_bytes()[..]].concat()
    };
    let partner_cases: Vec<Vec<u8>> = vec![
        vec![],
        partner_entry([7; 32], 1),
        partner_entry([7; 32], 100),
        partner_entry([7; 32], 101),
        partner_entry([7; 32], 0),
        partner_entry([0; 32], 5),
        [&[1u8, 33, 0][..], &[7; 33][..]].concat(),
        [&[1u8, 35, 0][..], &[7; 35][..]].concat(),
        vec![2, 0, 0],
        vec![1, 34],
    ];
    let partner_checks: Vec<Value> = partner_cases
        .iter()
        .map(|ext| {
            json!({
                "hex": hex(ext),
                "outcome": match intent_core::ext::partner(ext) {
                    Ok(Some(p)) => json!({ "ok": { "key": Pubkey::new_from_array(p.key).to_string(), "bps": p.bps } }),
                    Ok(None) => json!({ "ok": null }),
                    Err(e) => json!({ "err": format!("{e:?}") }),
                },
            })
        })
        .collect();
    let full = u64::MAX;
    let next_free: Vec<Value> = [
        (0u64, [0u64, 0, 0, 0]),
        (0, [1, 0, 0, 0]),
        (0, [0b1011, 0, 0, 0]),
        (1_000, [0b10, 0, 0, 0]),
        (0, [full, 0, 0, 0]),
        (7, [full, full, 3, 0]),
        (0, [full, full, full, full >> 1]),
        (0, [full, full, full, full]),
        (u64::MAX, [0, 0, 0, 0]),
        (u64::MAX, [1, 0, 0, 0]),
        (u64::MAX - 70, [full, 0b11, 0, 0]),
    ]
    .iter()
    .map(|(base, bits)| {
        json!({
            "base": base.to_string(),
            "bits": bits.iter().map(u64::to_string).collect::<Vec<_>>(),
            "next": intent_core::nonce::Window { base: *base, bits: *bits }.next_free().map(|n| n.to_string()),
        })
    })
    .collect();
    let fees: Vec<Value> = [
        (1u64, 1u16),
        (10_000, 1),
        (10_001, 1),
        (400, 5),
        (12_345, 0),
        (0, 100),
        (777, 10_000),
        (777, 10_001),
        (u64::MAX, 100),
        (101, 100),
    ]
    .iter()
    .map(|(amount, bps)| {
        json!({
            "amount": amount.to_string(),
            "bps": bps.to_string(),
            "result": match split_fee(*amount, *bps) {
                Ok(s) => json!({ "fee": s.fee.to_string(), "net": s.net.to_string() }),
                Err(e) => json!({ "err": format!("{e:?}") }),
            },
        })
    })
    .collect();

    let attested = Intent::AttestedResult(attested_result::Params {
        amount_in: 3_333,
        min_result: 10,
        max_result: 20,
        attestor: [5; 32],
        spec_hash: [0; 32],
        judge_fee: 0,
    });
    let attested_checks: Vec<Value> = [
        (3_333u64, 9u64),
        (3_333, 10),
        (3_333, 20),
        (3_333, 21),
        (3_332, 15),
    ]
    .iter()
    .map(|(amount_in, result)| {
        json!({
            "amount_in": amount_in.to_string(),
            "result": result.to_string(),
            "outcome": outcome(attested.check_attested(*amount_in, *result).map(|k| hex(&k))),
        })
    })
    .collect();

    let swap_params = swap_ok;
    let signed = SignedIntent {
        program: intent_engine::ID.to_bytes(),
        domain: svm_tests::DOMAIN,
        owner: owner.to_bytes(),
        owner_input: key(9).to_bytes(),
        input_mint: input_mint.to_bytes(),
        output_mint: output_mint.to_bytes(),
        receiver: key(6).to_bytes(),
        nonce: 42,
        expires_at: 1_700_003_600,
        submit_by: -7,
        kind: Kind::SwapExactIn as u8,
        flags: 0xa1b2,
        params: &swap_params,
        epoch: 0x0102_0304_0506_0708,
        ext_hash: solana_sha256_hasher::hashv(&[&GOLDEN_EXT]).to_bytes(),
        relayer_fee: 0x0a0b_0c0d,
    };
    let preimage = signed.preimage();
    let digest = solana_sha256_hasher::hashv(&[&preimage]).to_bytes();
    let envelope = offchain_envelope(&owner.to_bytes(), &digest);
    let oracle_ix = solana_ed25519_program::new_ed25519_instruction_with_signature(
        &envelope,
        &[0xab; 64],
        &owner.to_bytes(),
    );
    check_ed25519_ix(
        &ED25519_PROGRAM_ID,
        &oracle_ix.data,
        &owner.to_bytes(),
        &envelope,
    )
    .map_err(|e| format!("{e:?}"))?;
    let attest_preimage = AttestedFill {
        program: intent_engine::ID.to_bytes(),
        domain: svm_tests::DOMAIN,
        intent: key(7).to_bytes(),
        payee: key(8).to_bytes(),
        amount_in: 3_333,
        result: 15,
        filled: 0x1112_1314_1516_1718,
        revision: 0x2122_2324,
        max_fee_bps: 0x3132,
        ext_hash: solana_sha256_hasher::hashv(&[&GOLDEN_EXT]).to_bytes(),
    }
    .preimage();
    let attest_digest = solana_sha256_hasher::hashv(&[&attest_preimage]).to_bytes();
    let attestation = offchain_envelope(&key(5).to_bytes(), &attest_digest);
    let attest_spec_hash = [0x6a; 32];
    let proof_preimage = AttestedProof {
        program: intent_engine::ID.to_bytes(),
        domain: svm_tests::DOMAIN,
        intent: key(7).to_bytes(),
        payee: key(8).to_bytes(),
        amount_in: 3_333,
        result: 15,
        filled: 0x1112_1314_1516_1718,
        revision: 0x2122_2324,
        max_fee_bps: 0x3132,
        ext_hash: solana_sha256_hasher::hashv(&[&GOLDEN_EXT]).to_bytes(),
        spec_hash: attest_spec_hash,
    }
    .preimage();
    let proof_digest = solana_sha256_hasher::hashv(&[&proof_preimage]).to_bytes();
    let proof_attestation = offchain_envelope(&key(5).to_bytes(), &proof_digest);
    let sig = json!({
        "domain": hex(&svm_tests::DOMAIN),
        "receiver": key(6).to_string(),
        "owner_input": key(9).to_string(),
        "submit_by": "-7",
        "nonce": "42",
        "expires_at": "1700003600",
        "kind": "1",
        "flags": "41394",
        "epoch": "72623859790382856",
        "relayer_fee": signed.relayer_fee.to_string(),
        "ext": hex(&GOLDEN_EXT),
        "params": hex(&swap_params),
        "preimage": hex(&preimage),
        "digest": hex(&digest),
        "envelope": hex(&envelope),
        "ed25519_program": oracle_ix.program_id.to_string(),
        "ed25519_ix_data_with_ab_signature": hex(&oracle_ix.data),
        "attest_intent": key(7).to_string(),
        "attest_payee": key(8).to_string(),
        "attest_result": "15",
        "attest_amount_in": "3333",
        "attest_filled": "1230066625199609624",
        "attest_revision": "555885348",
        "attest_max_fee_bps": "12594",
        "attestor": key(5).to_string(),
        "attest_preimage": hex(&attest_preimage),
        "attest_message": hex(&attestation),
        "attest_spec_hash": hex(&attest_spec_hash),
        "attest_proof_preimage": hex(&proof_preimage),
        "attest_proof_message": hex(&proof_attestation),
    });

    let ext_cases: Vec<(Vec<u8>, Vec<u8>)> = vec![
        (vec![], vec![]),
        (vec![1, 0, 0], vec![]),
        (vec![1, 0, 0], vec![1]),
        (vec![0, 0, 0], vec![0]),
        (vec![1, 5, 0], vec![1]),
        (vec![7], vec![7]),
        (vec![7, 0], vec![7]),
        (vec![1, 0, 0, 2, 1, 0, 9], vec![1, 2]),
        (vec![2, 0, 0, 1, 0, 0], vec![1, 2]),
        (vec![1, 0, 0, 1, 0, 0], vec![1]),
        (vec![1, 0, 0, 3, 0, 0], vec![1, 2]),
        ([vec![1, 0xfd, 0x01], vec![0; 509]].concat(), vec![1]),
        ([vec![1, 0xfe, 0x01], vec![0; 510]].concat(), vec![1]),
        ([vec![1, 0xff, 0xff], vec![0; 3]].concat(), vec![1]),
    ];
    let ext_checks: Vec<Value> = ext_cases
        .iter()
        .map(|(ext, known)| {
            json!({
                "hex": hex(ext),
                "known": known,
                "outcome": outcome(intent_core::ext::validate(ext, known).map(|()| "valid")),
            })
        })
        .collect();
    let flag_checks: Vec<Value> = [0u16, 1, 0x8000, u16::MAX]
        .iter()
        .map(|f| {
            json!({
                "flags": f,
                "outcome": outcome(intent_core::ext::check_flags(*f).map(|()| "valid")),
            })
        })
        .collect();
    let kind_bits = json!({
        "1": Kind::SwapExactIn.bit().to_string(),
        "2": Kind::LimitOrder.bit().to_string(),
        "3": Kind::DutchAuction.bit().to_string(),
        "4": Kind::AttestedResult.bit().to_string(),
        "all": ALL_KINDS_MASK.to_string(),
    });
    let mut fits = Vec::new();
    for (name, intent) in intents()? {
        for expires_at in [
            i64::MIN,
            1_700_003_599,
            1_700_003_600,
            1_700_003_601,
            i64::MAX,
        ] {
            fits.push(json!({
                "name": name,
                "expires_at": expires_at.to_string(),
                "fits": intent.fits_expiry(expires_at),
            }));
        }
    }

    let mul_div: Vec<Value> = [
        (7u64, 3u64, 2u64),
        (6, 4, 3),
        (3, 4, 1),
        (1, 1, 0),
        (u64::MAX, u64::MAX, u64::MAX),
        (u64::MAX, 2, 1),
        (u64::MAX, 3, 3),
        (31, 1_190_112_520_884_487_201, 2),
        (u64::MAX, u64::MAX - 1, u64::MAX),
        (0, u64::MAX, 1),
    ]
    .into_iter()
    .chain(random_mul_div())
    .collect::<Vec<_>>()
    .iter()
    .map(|(a, b, d)| {
        json!({
            "a": a.to_string(),
            "b": b.to_string(),
            "d": d.to_string(),
            "floor": outcome(mul_div_floor(*a, *b, *d)),
            "ceil": outcome(mul_div_ceil(*a, *b, *d)),
        })
    })
    .collect();

    let create = ix::CreateIntent {
        args: intent_engine::CreateIntentArgs {
            nonce: 42,
            kind: Kind::SwapExactIn as u8,
            flags: 3,
            params: swap_ok,
            expires_at: 1_700_000_000,
            ext: intent_engine::Ext(GOLDEN_EXT.to_vec()),
            max_create_fee: 0x0102_0304,
            max_bounty: 0x0506_0708,
        },
    };
    let mandate = ix::CreateMandate {
        args: intent_engine::MandateArgs {
            id: 7,
            agent: key(0x0a),
            kinds: 0b1110,
            per_intent: 400,
            total: 1_000,
            max_intents: 4,
            max_ttl: 3_600,
            valid_until: 1_700_086_400,
            floor_out: 3,
            floor_in: 2,
            partner: key(0x0b),
            partner_bps: 25,
            agent_fee: 9,
        },
    };
    let data = json!([
        { "name": "create_intent", "hex": hex(&create.data()) },
        { "name": "fill_intent", "hex": hex(&ix::FillIntent { amount_in: 1_000_000, amount_out: 990_000, max_fee_bps: 100, ext: intent_engine::Ext(GOLDEN_EXT.to_vec()) }.data()) },
        { "name": "advance_nonce", "hex": hex(&ix::AdvanceNonce { nonce_base: 300 }.data()) },
        { "name": "raise_pause", "hex": hex(&ix::RaisePause { flags: 1 }.data()) },
        { "name": "create_mandate", "hex": hex(&mandate.data()) },
    ]);
    let discriminators = json!({
        "init_config": hex(ix::InitConfig::DISCRIMINATOR),
        "update_config": hex(ix::UpdateConfig::DISCRIMINATOR),
        "propose_admin": hex(ix::ProposeAdmin::DISCRIMINATOR),
        "accept_admin": hex(ix::AcceptAdmin::DISCRIMINATOR),
        "raise_pause": hex(ix::RaisePause::DISCRIMINATOR),
        "init_user": hex(ix::InitUser::DISCRIMINATOR),
        "advance_nonce": hex(ix::AdvanceNonce::DISCRIMINATOR),
        "advance_epoch": hex(ix::AdvanceEpoch::DISCRIMINATOR),
        "create_intent": hex(ix::CreateIntent::DISCRIMINATOR),
        "fill_intent": hex(ix::FillIntent::DISCRIMINATOR),
        "cancel_intent": hex(ix::CancelIntent::DISCRIMINATOR),
        "expire_intent": hex(ix::ExpireIntent::DISCRIMINATOR),
        "close_intent": hex(ix::CloseIntent::DISCRIMINATOR),
        "create_mandate": hex(ix::CreateMandate::DISCRIMINATOR),
        "revoke_mandate": hex(ix::RevokeMandate::DISCRIMINATOR),
        "create_intent_by_agent": hex(ix::CreateIntentByAgent::DISCRIMINATOR),
    });

    let event_discriminators = json!({
        "AdminAccepted": hex(ev::AdminAccepted::DISCRIMINATOR),
        "AdminProposed": hex(ev::AdminProposed::DISCRIMINATOR),
        "AgentPaid": hex(ev::AgentPaid::DISCRIMINATOR),
        "ConfigInitialized": hex(ev::ConfigInitialized::DISCRIMINATOR),
        "ConfigUpdated": hex(ev::ConfigUpdated::DISCRIMINATOR),
        "EconomicsUpdated": hex(ev::EconomicsUpdated::DISCRIMINATOR),
        "EpochAdvanced": hex(ev::EpochAdvanced::DISCRIMINATOR),
        "FeeWithheld": hex(ev::FeeWithheld::DISCRIMINATOR),
        "FillBegun": hex(ev::FillBegun::DISCRIMINATOR),
        "FillEnded": hex(ev::FillEnded::DISCRIMINATOR),
        "IntentAttested": hex(ev::IntentAttested::DISCRIMINATOR),
        "IntentCancelled": hex(ev::IntentCancelled::DISCRIMINATOR),
        "IntentClosed": hex(ev::IntentClosed::DISCRIMINATOR),
        "IntentCreated": hex(ev::IntentCreated::DISCRIMINATOR),
        "IntentExpired": hex(ev::IntentExpired::DISCRIMINATOR),
        "IntentFilled": hex(ev::IntentFilled::DISCRIMINATOR),
        "IntentSplit": hex(ev::IntentSplit::DISCRIMINATOR),
        "MandateClosed": hex(ev::MandateClosed::DISCRIMINATOR),
        "MandateCreated": hex(ev::MandateCreated::DISCRIMINATOR),
        "MandateUsed": hex(ev::MandateUsed::DISCRIMINATOR),
        "NonceAdvanced": hex(ev::NonceAdvanced::DISCRIMINATOR),
        "PauseLowered": hex(ev::PauseLowered::DISCRIMINATOR),
        "PauseRaised": hex(ev::PauseRaised::DISCRIMINATOR),
        "RelayerPaid": hex(ev::RelayerPaid::DISCRIMINATOR),
        "UserInitialized": hex(ev::UserInitialized::DISCRIMINATOR),
    });
    let mandate_lanes: Vec<Value> = [
        0u64,
        1,
        2,
        7,
        intent_core::mandate::MAX_LANE_SERIAL,
        intent_core::mandate::MAX_LANE_SERIAL + 1,
    ]
    .iter()
    .map(|serial| {
        json!({
            "serial": serial.to_string(),
            "lane": intent_core::mandate::lane_of(*serial).map(|l| l.to_string()),
        })
    })
    .collect();
    Ok(json!({
        "program": intent_engine::ID.to_string(),
        "keys": {
            "owner": owner.to_string(),
            "input_mint": input_mint.to_string(),
            "output_mint": output_mint.to_string(),
            "fee_recipient": fee_recipient.to_string(),
        },
        "pdas": pdas,
        "atas": atas,
        "params": params,
        "decode": decodes,
        "required_out": required,
        "split_fee": fees,
        "split_fees": three_way,
        "partner_checks": partner_checks,
        "next_free_nonce": next_free,
        "mul_div": mul_div,
        "kind_bits": kind_bits,
        "attested_checks": attested_checks,
        "ext_checks": ext_checks,
        "mandate_nonce_bit": intent_core::mandate::MANDATE_NONCE_BIT.to_string(),
        "mandate_lanes": mandate_lanes,
        "versions": json!({
            "config": intent_engine::state::CONFIG_VERSION,
            "user": intent_engine::state::USER_VERSION,
            "intent": intent_engine::state::INTENT_VERSION,
        }),
        "pause": json!({
            "create": intent_engine::state::PAUSE_CREATE,
            "fill": intent_engine::state::PAUSE_FILL,
        }),
        "flag_checks": flag_checks,
        "sig": sig,
        "random_signed": random_signed(),
        "random_dutch": random_dutch(),
        "economics_caps": {
            "create_fee": intent_engine::state::MAX_CREATE_FEE,
            "crank_bounty": intent_engine::state::MAX_CRANK_BOUNTY,
        },
        "jump_caps": {
            "nonce": intent_core::nonce::MAX_NONCE_JUMP.to_string(),
            "epoch": intent_core::nonce::MAX_EPOCH_JUMP.to_string(),
            "nonce_ceiling": intent_core::nonce::NONCE_CEILING.to_string(),
        },
        "fits_expiry": fits,
        "instruction_data": data,
        "discriminators": discriminators,
        "event_ix_tag": hex(anchor_lang::event::EVENT_IX_TAG_LE),
        "event_discriminators": event_discriminators,
    }))
}

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/core/test/golden/vectors.json")
}

#[test]
fn golden_vectors_match_the_committed_fixture() -> TestResult {
    let rendered = format!("{}\n", serde_json::to_string_pretty(&vectors()?)?);
    let path = fixture_path();
    if std::env::var_os("GOLDEN_WRITE").is_some() {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&path, &rendered)?;
    }
    let committed = std::fs::read_to_string(&path)?.replace("\r\n", "\n");
    assert_eq!(
        committed, rendered,
        "packages/core/test/golden/vectors.json drifted from the Rust implementation; rerun with GOLDEN_WRITE=1 and review the diff"
    );
    Ok(())
}
