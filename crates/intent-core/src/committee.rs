use crate::Error;

pub const MAX_MEMBERS: usize = 8;
pub const MAX_THRESHOLD: u8 = 3;
pub const COMMITTEE_TAG: [u8; 16] = *b"intent-engine-cm";
pub const COMMITTEE_COSIGN_TAG: [u8; 32] = *b"intent-engine-committee-member\0\0";
pub const COMMITTEE_PREIMAGE_LEN: usize = 16 + 1 + 1 + 32 * MAX_MEMBERS + 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Committee {
    threshold: u8,
    count: u8,
    members: [[u8; 32]; MAX_MEMBERS],
    fee_wallet: [u8; 32],
}

impl Committee {
    pub fn new(members: &[[u8; 32]], threshold: u8, fee_wallet: [u8; 32]) -> Result<Self, Error> {
        let count = u8::try_from(members.len()).map_err(|_| Error::CommitteeInvalid)?;
        let sized = !members.is_empty() && members.len() <= MAX_MEMBERS;
        let reachable = threshold != 0 && threshold <= count && threshold <= MAX_THRESHOLD;
        let ascending = members.windows(2).all(|pair| pair.first() < pair.last());
        let named = members.iter().all(|member| *member != [0; 32]) && fee_wallet != [0; 32];
        if !(sized && reachable && ascending && named) {
            return Err(Error::CommitteeInvalid);
        }
        let mut padded = [[0; 32]; MAX_MEMBERS];
        for (slot, member) in padded.iter_mut().zip(members) {
            *slot = *member;
        }
        Ok(Self {
            threshold,
            count,
            members: padded,
            fee_wallet,
        })
    }

    pub fn from_stored(
        threshold: u8,
        count: u8,
        members: &[[u8; 32]; MAX_MEMBERS],
        fee_wallet: [u8; 32],
    ) -> Result<Self, Error> {
        let (named, rest) = members
            .split_at_checked(usize::from(count))
            .ok_or(Error::CommitteeInvalid)?;
        if rest.iter().any(|slot| *slot != [0; 32]) {
            return Err(Error::CommitteeInvalid);
        }
        Self::new(named, threshold, fee_wallet)
    }

    pub fn threshold(&self) -> u8 {
        self.threshold
    }

    pub fn fee_wallet(&self) -> [u8; 32] {
        self.fee_wallet
    }

    pub fn members(&self) -> &[[u8; 32]] {
        self.members
            .get(..usize::from(self.count))
            .unwrap_or_default()
    }

    pub fn preimage(&self) -> [u8; COMMITTEE_PREIMAGE_LEN] {
        let mut out = [0; COMMITTEE_PREIMAGE_LEN];
        let counts = [self.threshold, self.count];
        let parts = COMMITTEE_TAG
            .iter()
            .chain(counts.iter())
            .chain(self.members.iter().flatten())
            .chain(self.fee_wallet.iter());
        for (slot, byte) in out.iter_mut().zip(parts) {
            *slot = *byte;
        }
        out
    }

    pub fn signers(&self, mask: u8) -> Result<Signers, Error> {
        let beyond = mask.checked_shr(u32::from(self.count)).unwrap_or(0) != 0;
        if beyond || mask.count_ones() < u32::from(self.threshold) {
            return Err(Error::CommitteeSigners);
        }
        let mut keys = [[0; 32]; MAX_MEMBERS];
        let mut len = 0usize;
        for (bit, member) in (0u32..).zip(self.members()) {
            if mask & 1u8.checked_shl(bit).unwrap_or(0) != 0 {
                if let Some(slot) = keys.get_mut(len) {
                    *slot = *member;
                }
                len = len.checked_add(1).ok_or(Error::Overflow)?;
            }
        }
        Ok(Signers { keys, len })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Signers {
    keys: [[u8; 32]; MAX_MEMBERS],
    len: usize,
}

impl Signers {
    pub fn keys(&self) -> &[[u8; 32]] {
        self.keys.get(..self.len).unwrap_or_default()
    }
}
