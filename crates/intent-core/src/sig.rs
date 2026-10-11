use crate::{Error, PARAMS_LEN};

pub const ED25519_PROGRAM_ID: [u8; 32] = [
    3, 125, 70, 214, 124, 147, 251, 190, 18, 249, 66, 143, 131, 141, 64, 255, 5, 112, 116, 73, 39,
    244, 138, 100, 252, 202, 112, 68, 128, 0, 0, 0,
];

pub const INTENT_TAG: [u8; 16] = *b"intent-engine-v1";
pub const ATTEST_TAG: [u8; 16] = *b"intent-engine-at";
pub const OFFCHAIN_PREFIX: [u8; 16] = *b"\xffsolana offchain";

pub const PUBKEY_OFFSET: u16 = 16;
pub const SIGNATURE_OFFSET: u16 = 48;
pub const MESSAGE_OFFSET: u16 = 112;
pub const PREIMAGE_LEN: usize = 448;
pub const ENVELOPE_LEN: usize = 114;
pub const ATTEST_PREIMAGE_LEN: usize = 206;

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

pub fn offchain_envelope(signer: &[u8; 32], digest: &[u8; 32]) -> [u8; ENVELOPE_LEN] {
    let mut hex = [0u8; 64];
    for (pair, byte) in hex.as_chunks_mut::<2>().0.iter_mut().zip(digest) {
        for (dst, nibble) in pair.iter_mut().zip([byte / 16, byte % 16]) {
            *dst = hex_digit(nibble);
        }
    }
    Buf::<ENVELOPE_LEN>::new()
        .put(&OFFCHAIN_PREFIX)
        .put(&[1, 1])
        .put(signer)
        .put(&hex)
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
