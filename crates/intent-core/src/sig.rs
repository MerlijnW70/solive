use crate::{Error, PARAMS_LEN};

pub const ED25519_PROGRAM_ID: [u8; 32] = [
    3, 125, 70, 214, 124, 147, 251, 190, 18, 249, 66, 143, 131, 141, 64, 255, 5, 112, 116, 73, 39,
    244, 138, 100, 252, 202, 112, 68, 128, 0, 0, 0,
];

pub const INTENT_TAG: [u8; 16] = *b"intent-engine-v1";
pub const ATTEST_TAG: [u8; 16] = *b"intent-engine-at";
pub const ATTEST_DELIVERY_TAG: [u8; 16] = *b"intent-engine-dl";
pub const ATTEST_SPLIT_DELIVERY_TAG: [u8; 16] = *b"intent-engine-sd";
pub const SPLIT_COSIGN_TAG: [u8; 32] = *b"intent-engine-split-cosigner\0\0\0\0";
pub const RETIRED_TAGS: [[u8; 16]; 2] = [*b"intent-engine-pf", *b"intent-engine-sp"];
pub const OFFCHAIN_PREFIX: [u8; 16] = *b"\xffsolana offchain";

pub const PUBKEY_OFFSET: u16 = 16;
pub const SIGNATURE_OFFSET: u16 = 48;
pub const MESSAGE_OFFSET: u16 = 112;
pub const PREIMAGE_LEN: usize = 448;
pub const ENVELOPE_LEN: usize = 114;
pub const ATTEST_PREIMAGE_LEN: usize = 206;
pub const ATTEST_DELIVERY_PREIMAGE_LEN: usize = 326;
pub const ATTEST_SPLIT_DELIVERY_PREIMAGE_LEN: usize = 326;
pub const MAX_COSIGNERS: usize = 16;
pub const COSIGN_KEYS_AT: usize = 18;
pub const COSIGN_ENVELOPE_MAX: usize = COSIGN_KEYS_AT + 32 * MAX_COSIGNERS + 64;

struct Buf<const N: usize> {
    out: [u8; N],
    at: usize,
}

impl<const N: usize> Buf<N> {
    fn new() -> Self {
        Self { out: [0; N], at: 0 }
    }

    fn put(mut self, bytes: &[u8]) -> Self {
        for (dst, src) in self.out.iter_mut().skip(self.at).zip(bytes) {
            *dst = *src;
        }
        self.at = self.at.saturating_add(bytes.len());
        self
    }
}

pub fn ed25519_header(message_len: u16) -> [u8; 16] {
    Buf::<16>::new()
        .put(&[1, 0])
        .put(&SIGNATURE_OFFSET.to_le_bytes())
        .put(&u16::MAX.to_le_bytes())
        .put(&PUBKEY_OFFSET.to_le_bytes())
        .put(&u16::MAX.to_le_bytes())
        .put(&MESSAGE_OFFSET.to_le_bytes())
        .put(&message_len.to_le_bytes())
        .put(&u16::MAX.to_le_bytes())
        .out
}

pub fn check_ed25519_ix(
    program: &[u8; 32],
    data: &[u8],
    pubkey: &[u8; 32],
    message: &[u8],
) -> Result<(), Error> {
    if program != &ED25519_PROGRAM_ID {
        return Err(Error::SigProgram);
    }
    let len = u16::try_from(message.len()).map_err(|_| Error::SigMessage)?;
    if data.get(..16) != Some(&ed25519_header(len)[..]) {
        return Err(Error::SigHeader);
    }
    if data.get(16..48) != Some(&pubkey[..]) {
        return Err(Error::SigPubkey);
    }
    if data.get(112..) != Some(message) {
        return Err(Error::SigMessage);
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cosigners {
    keys: [[u8; 32]; MAX_COSIGNERS],
    count: usize,
}

impl Cosigners {
    pub fn new(keys: &[[u8; 32]]) -> Result<Self, Error> {
        if keys.is_empty() || keys.len() > MAX_COSIGNERS {
            return Err(Error::SigHeader);
        }
        let mut sorted = [[0u8; 32]; MAX_COSIGNERS];
        for (slot, key) in sorted.iter_mut().zip(keys) {
            *slot = *key;
        }
        let filled = sorted.get_mut(..keys.len()).ok_or(Error::SigHeader)?;
        filled.sort_unstable();
        let mut out = [[0u8; 32]; MAX_COSIGNERS];
        let mut count = 0usize;
        let mut last: Option<[u8; 32]> = None;
        for key in filled.iter() {
            if last == Some(*key) {
                continue;
            }
            let slot = out.get_mut(count).ok_or(Error::SigHeader)?;
            *slot = *key;
            count = count.checked_add(1).ok_or(Error::SigHeader)?;
            last = Some(*key);
        }
        Ok(Self { keys: out, count })
    }

    pub fn keys(&self) -> &[[u8; 32]] {
        self.keys.get(..self.count).unwrap_or_default()
    }

    pub fn slot(&self, key: &[u8; 32]) -> Option<usize> {
        self.keys().binary_search(key).ok()
    }

    pub fn envelope(&self, digest: &[u8; 32]) -> CosignEnvelope {
        let mut out = Buf::<COSIGN_ENVELOPE_MAX>::new()
            .put(&OFFCHAIN_PREFIX)
            .put(&[1, u8::try_from(self.count).unwrap_or(u8::MAX)]);
        for key in self.keys() {
            out = out.put(key);
        }
        let out = out.put(&hex_of(digest));
        CosignEnvelope {
            len: out.at,
            bytes: out.out,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CosignEnvelope {
    bytes: [u8; COSIGN_ENVELOPE_MAX],
    len: usize,
}

impl CosignEnvelope {
    pub fn as_bytes(&self) -> &[u8] {
        self.bytes.get(..self.len).unwrap_or_default()
    }
}

fn cosign_entry(
    sig_at: usize,
    pubkey_at: usize,
    message_at: usize,
    message_len: u16,
) -> Result<[u8; 14], Error> {
    let sig = u16::try_from(sig_at).map_err(|_| Error::SigHeader)?;
    let pubkey = u16::try_from(pubkey_at).map_err(|_| Error::SigHeader)?;
    let message = u16::try_from(message_at).map_err(|_| Error::SigHeader)?;
    Ok(Buf::<14>::new()
        .put(&sig.to_le_bytes())
        .put(&u16::MAX.to_le_bytes())
        .put(&pubkey.to_le_bytes())
        .put(&u16::MAX.to_le_bytes())
        .put(&message.to_le_bytes())
        .put(&message_len.to_le_bytes())
        .put(&u16::MAX.to_le_bytes())
        .out)
}

pub fn check_ed25519_cosign(
    program: &[u8; 32],
    data: &[u8],
    listed: &Cosigners,
    signers: &Cosigners,
    digest: &[u8; 32],
) -> Result<(), Error> {
    if program != &ED25519_PROGRAM_ID {
        return Err(Error::SigProgram);
    }
    let envelope = listed.envelope(digest);
    let message = envelope.as_bytes();
    let message_len = u16::try_from(message.len()).map_err(|_| Error::SigMessage)?;
    let m = signers.keys().len();
    let count = u8::try_from(m).map_err(|_| Error::SigHeader)?;
    if data.first() != Some(&count) || data.get(1) != Some(&0) {
        return Err(Error::SigHeader);
    }
    let sigs_at = m
        .checked_mul(14)
        .and_then(|entries| entries.checked_add(2))
        .ok_or(Error::SigHeader)?;
    let message_at = m
        .checked_mul(64)
        .and_then(|sigs| sigs.checked_add(sigs_at))
        .ok_or(Error::SigHeader)?;
    let total = message_at
        .checked_add(message.len())
        .ok_or(Error::SigHeader)?;
    if data.len() != total {
        return Err(Error::SigHeader);
    }
    for (k, signer) in signers.keys().iter().enumerate() {
        let slot = listed.slot(signer).ok_or(Error::SigPubkey)?;
        let pubkey_at = slot
            .checked_mul(32)
            .and_then(|at| at.checked_add(COSIGN_KEYS_AT))
            .and_then(|at| at.checked_add(message_at))
            .ok_or(Error::SigHeader)?;
        let sig_at = k
            .checked_mul(64)
            .and_then(|at| at.checked_add(sigs_at))
            .ok_or(Error::SigHeader)?;
        let entry_at = k
            .checked_mul(14)
            .and_then(|at| at.checked_add(2))
            .ok_or(Error::SigHeader)?;
        let entry_end = entry_at.checked_add(14).ok_or(Error::SigHeader)?;
        let expected = cosign_entry(sig_at, pubkey_at, message_at, message_len)?;
        if data.get(entry_at..entry_end) != Some(&expected[..]) {
            return Err(Error::SigHeader);
        }
    }
    if data.get(message_at..) != Some(message) {
        return Err(Error::SigMessage);
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SignedIntent<'a> {
    pub program: [u8; 32],
    pub domain: [u8; 32],
    pub owner: [u8; 32],
    pub owner_input: [u8; 32],
    pub input_mint: [u8; 32],
    pub output_mint: [u8; 32],
    pub receiver: [u8; 32],
    pub nonce: u64,
    pub expires_at: i64,
    pub submit_by: i64,
    pub kind: u8,
    pub flags: u16,
    pub params: &'a [u8; PARAMS_LEN],
    pub epoch: u64,
    pub ext_hash: [u8; 32],
    pub relayer_fee: u64,
}

impl SignedIntent<'_> {
    pub fn preimage(&self) -> [u8; PREIMAGE_LEN] {
        Buf::<PREIMAGE_LEN>::new()
            .put(&INTENT_TAG)
            .put(&self.program)
            .put(&self.domain)
            .put(&self.owner)
            .put(&self.owner_input)
            .put(&self.input_mint)
            .put(&self.output_mint)
            .put(&self.receiver)
            .put(&self.nonce.to_le_bytes())
            .put(&self.expires_at.to_le_bytes())
            .put(&self.submit_by.to_le_bytes())
            .put(&[self.kind])
            .put(&self.flags.to_le_bytes())
            .put(&[0, 0, 0, 0, 0])
            .put(self.params)
            .put(&self.epoch.to_le_bytes())
            .put(&self.ext_hash)
            .put(&self.relayer_fee.to_le_bytes())
            .out
    }
}

fn hex_digit(nibble: u8) -> u8 {
    if nibble < 10 {
        b'0'.wrapping_add(nibble)
    } else {
        b'a'.wrapping_add(nibble.wrapping_sub(10))
    }
}

fn hex_of(digest: &[u8; 32]) -> [u8; 64] {
    let mut hex = [0u8; 64];
    for (pair, byte) in hex.as_chunks_mut::<2>().0.iter_mut().zip(digest) {
        for (dst, nibble) in pair.iter_mut().zip([byte / 16, byte % 16]) {
            *dst = hex_digit(nibble);
        }
    }
    hex
}

pub fn offchain_envelope(signer: &[u8; 32], digest: &[u8; 32]) -> [u8; ENVELOPE_LEN] {
    Buf::<ENVELOPE_LEN>::new()
        .put(&OFFCHAIN_PREFIX)
        .put(&[1, 1])
        .put(signer)
        .put(&hex_of(digest))
        .out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttestedFill {
    pub program: [u8; 32],
    pub domain: [u8; 32],
    pub intent: [u8; 32],
    pub payee: [u8; 32],
    pub amount_in: u64,
    pub result: u64,
    pub filled: u64,
    pub revision: u32,
    pub max_fee_bps: u16,
    pub ext_hash: [u8; 32],
}

impl AttestedFill {
    pub fn preimage(&self) -> [u8; ATTEST_PREIMAGE_LEN] {
        Buf::<ATTEST_PREIMAGE_LEN>::new()
            .put(&ATTEST_TAG)
            .put(&self.program)
            .put(&self.domain)
            .put(&self.intent)
            .put(&self.payee)
            .put(&self.amount_in.to_le_bytes())
            .put(&self.result.to_le_bytes())
            .put(&self.filled.to_le_bytes())
            .put(&self.revision.to_le_bytes())
            .put(&self.max_fee_bps.to_le_bytes())
            .put(&self.ext_hash)
            .out
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttestedDelivery {
    pub program: [u8; 32],
    pub domain: [u8; 32],
    pub intent: [u8; 32],
    pub payee: [u8; 32],
    pub amount_in: u64,
    pub result: u64,
    pub filled: u64,
    pub revision: u32,
    pub max_fee_bps: u16,
    pub ext_hash: [u8; 32],
    pub spec_hash: [u8; 32],
    pub announcement: [u8; 32],
    pub seq: u64,
    pub delivered: [u8; 32],
    pub salt: [u8; 16],
}

impl AttestedDelivery {
    pub fn preimage(&self) -> [u8; ATTEST_DELIVERY_PREIMAGE_LEN] {
        Buf::<ATTEST_DELIVERY_PREIMAGE_LEN>::new()
            .put(&ATTEST_DELIVERY_TAG)
            .put(&self.program)
            .put(&self.domain)
            .put(&self.intent)
            .put(&self.payee)
            .put(&self.amount_in.to_le_bytes())
            .put(&self.result.to_le_bytes())
            .put(&self.filled.to_le_bytes())
            .put(&self.revision.to_le_bytes())
            .put(&self.max_fee_bps.to_le_bytes())
            .put(&self.ext_hash)
            .put(&self.spec_hash)
            .put(&self.announcement)
            .put(&self.seq.to_le_bytes())
            .put(&self.delivered)
            .put(&self.salt)
            .out
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttestedSplitDelivery {
    pub program: [u8; 32],
    pub domain: [u8; 32],
    pub intent: [u8; 32],
    pub amount_in: u64,
    pub result: u64,
    pub filled: u64,
    pub revision: u32,
    pub max_fee_bps: u16,
    pub ext_hash: [u8; 32],
    pub spec_hash: [u8; 32],
    pub split_hash: [u8; 32],
    pub announcement: [u8; 32],
    pub seq: u64,
    pub delivered: [u8; 32],
    pub salt: [u8; 16],
}

impl AttestedSplitDelivery {
    pub fn preimage(&self) -> [u8; ATTEST_SPLIT_DELIVERY_PREIMAGE_LEN] {
        Buf::<ATTEST_SPLIT_DELIVERY_PREIMAGE_LEN>::new()
            .put(&ATTEST_SPLIT_DELIVERY_TAG)
            .put(&self.program)
            .put(&self.domain)
            .put(&self.intent)
            .put(&self.amount_in.to_le_bytes())
            .put(&self.result.to_le_bytes())
            .put(&self.filled.to_le_bytes())
            .put(&self.revision.to_le_bytes())
            .put(&self.max_fee_bps.to_le_bytes())
            .put(&self.ext_hash)
            .put(&self.spec_hash)
            .put(&self.split_hash)
            .put(&self.announcement)
            .put(&self.seq.to_le_bytes())
            .put(&self.delivered)
            .put(&self.salt)
            .out
    }
}
