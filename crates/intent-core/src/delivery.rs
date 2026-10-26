use crate::claim::Slot;
use crate::clock::elapsed;
use crate::Error;

pub const COMMITMENT_TAG: [u8; 16] = *b"intent-engine-dc";
pub const FINGERPRINT_TAG: [u8; 16] = *b"intent-engine-fp";
pub const BLOB_VERSION: u8 = 4;
pub const SALT_LEN: usize = 16;
pub const FINGERPRINT_LEN: usize = 8;
pub const MAX_BLOB_RECIPIENTS: usize = 8;
pub const MAX_BLOB_URL: usize = 200;
pub const BLOB_HEAD_LEN: usize = 3;
pub const BLOB_FIXED_LEN: usize = BLOB_HEAD_LEN + 32 + 32 + SALT_LEN + 16;
pub const BLOB_PER_RECIPIENT_LEN: usize = FINGERPRINT_LEN + 32;
pub const MAX_SEALED_BLOB: usize = 624;
pub const REFUTE_WINDOW_SECS: i64 = 30 * 86_400;
pub const MAX_SPLIT_RECIPIENTS: usize = 8;
pub const SPLIT_ENTRY_LEN: usize = 34;
pub const COMMITMENT_PREIMAGE_LEN: usize = 16 + 32 + 32 + SALT_LEN + 32;
pub const FINGERPRINT_PREIMAGE_LEN: usize = 16 + 32;

pub fn commitment_preimage(
    intent: &[u8; 32],
    worker: &[u8; 32],
    salt: &[u8; SALT_LEN],
    sha256: &[u8; 32],
) -> [u8; COMMITMENT_PREIMAGE_LEN] {
    let mut out = [0u8; COMMITMENT_PREIMAGE_LEN];
    let parts: [&[u8]; 5] = [&COMMITMENT_TAG, intent, worker, salt, sha256];
    let mut at = 0usize;
    for part in parts {
        for (dst, src) in out.iter_mut().skip(at).zip(part) {
            *dst = *src;
        }
        at = at.saturating_add(part.len());
    }
    out
}

pub fn fingerprint_preimage(key: &[u8; 32]) -> [u8; FINGERPRINT_PREIMAGE_LEN] {
    let mut out = [0u8; FINGERPRINT_PREIMAGE_LEN];
    for (dst, src) in out.iter_mut().zip(FINGERPRINT_TAG.iter().chain(key.iter())) {
        *dst = *src;
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlobHead {
    pub count: u8,
    pub mask: u8,
    pub fps: [[u8; FINGERPRINT_LEN]; MAX_BLOB_RECIPIENTS],
    pub url_len: u16,
}

pub fn blob_head(bytes: &[u8]) -> Result<BlobHead, Error> {
    let [version, count, mask] = *bytes.get(..BLOB_HEAD_LEN).ok_or(Error::BlobMalformed)? else {
        return Err(Error::BlobMalformed);
    };
    let n = usize::from(count);
    if version != BLOB_VERSION || n == 0 || n > MAX_BLOB_RECIPIENTS || u32::from(mask) >> n != 0 {
        return Err(Error::BlobMalformed);
    }
    let fixed = BLOB_PER_RECIPIENT_LEN
        .checked_mul(n)
        .and_then(|per| per.checked_add(BLOB_FIXED_LEN))
        .ok_or(Error::BlobMalformed)?;
    let url = bytes.len().checked_sub(fixed).ok_or(Error::BlobMalformed)?;
    if url == 0 || url > MAX_BLOB_URL || bytes.len() > MAX_SEALED_BLOB {
        return Err(Error::BlobMalformed);
    }
    let mut fps = [[0u8; FINGERPRINT_LEN]; MAX_BLOB_RECIPIENTS];
    let listed = bytes
        .get(BLOB_HEAD_LEN..)
        .ok_or(Error::BlobMalformed)?
        .as_chunks::<FINGERPRINT_LEN>()
        .0
        .iter()
        .take(n);
    for (fp, chunk) in fps.iter_mut().zip(listed) {
        fp.copy_from_slice(chunk);
    }
    Ok(BlobHead {
        count,
        mask,
        fps,
        url_len: u16::try_from(url).map_err(|_| Error::BlobMalformed)?,
    })
}

pub fn may_announce(slot: Slot, worker: [u8; 32]) -> Result<(), Error> {
    match slot {
        Slot::Held { worker: holder, .. } if holder != worker => Err(Error::ClaimHeld),
        _ => Ok(()),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnnState {
    Announced,
    Paid,
}

impl TryFrom<u8> for AnnState {
    type Error = Error;

    fn try_from(byte: u8) -> Result<Self, Error> {
        match byte {
            0 => Ok(Self::Announced),
            1 => Ok(Self::Paid),
            _ => Err(Error::AnnouncementState),
        }
    }
}

impl From<AnnState> for u8 {
    fn from(state: AnnState) -> Self {
        match state {
            AnnState::Announced => 0,
            AnnState::Paid => 1,
        }
    }
}

pub fn closable(
    state: AnnState,
    by_worker: bool,
    intent_open: bool,
    now: i64,
    expires_at: i64,
    paid_at: i64,
) -> Result<(), Error> {
    let after = |from: i64| -> Result<(), Error> {
        if elapsed(now, from, REFUTE_WINDOW_SECS) {
            Ok(())
        } else {
            Err(Error::AnnouncementRetained)
        }
    };
    match state {
        AnnState::Announced if by_worker => {
            if intent_open {
                Err(Error::AnnouncementOpen)
            } else {
                Ok(())
            }
        }
        AnnState::Announced => after(expires_at),
        AnnState::Paid => after(paid_at),
    }
}

pub fn refutes(
    earlier_seq: u64,
    paid_seq: u64,
    earlier_worker: [u8; 32],
    payees: &[[u8; 32]],
) -> Result<(), Error> {
    if earlier_seq >= paid_seq {
        return Err(Error::RefuteNotEarlier);
    }
    if payees.contains(&earlier_worker) {
        return Err(Error::RefuteSamePayee);
    }
    Ok(())
}

pub type SplitPreimage = [u8; SPLIT_ENTRY_LEN * MAX_SPLIT_RECIPIENTS];

pub fn split_hash_preimage(
    recipients: &[[u8; 32]],
    weights: &[u16],
) -> Result<(SplitPreimage, usize), Error> {
    let n = recipients.len();
    if n == 0 || n > MAX_SPLIT_RECIPIENTS || weights.len() != n {
        return Err(Error::SplitCountMismatch);
    }
    let mut out = [0u8; SPLIT_ENTRY_LEN * MAX_SPLIT_RECIPIENTS];
    for ((entry, wallet), bps) in out
        .as_chunks_mut::<SPLIT_ENTRY_LEN>()
        .0
        .iter_mut()
        .zip(recipients)
        .zip(weights)
    {
        let (key, weight) = entry.split_at_mut(32);
        key.copy_from_slice(wallet);
        weight.copy_from_slice(&bps.to_le_bytes());
    }
    let len = SPLIT_ENTRY_LEN.checked_mul(n).ok_or(Error::Overflow)?;
    Ok((out, len))
}
