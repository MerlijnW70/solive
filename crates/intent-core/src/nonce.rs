use crate::mandate::MANDATE_NONCE_BIT;
use crate::Error;

pub const WINDOW_BITS: u64 = 256;
pub const MAX_NONCE_JUMP: u64 = 1 << 32;
pub const MAX_EPOCH_JUMP: u64 = 1 << 48;
pub const NONCE_CEILING: u64 = MANDATE_NONCE_BIT - WINDOW_BITS;

pub fn nonce_jump_allowed(base: u64, new_base: u64) -> bool {
    new_base <= NONCE_CEILING
        && new_base
            .checked_sub(base)
            .is_some_and(|d| d <= MAX_NONCE_JUMP)
}

pub fn epoch_jump_allowed(epoch: u64, new_epoch: u64) -> bool {
    new_epoch
        .checked_sub(epoch)
        .is_some_and(|d| d <= MAX_EPOCH_JUMP)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window {
    pub base: u64,
    pub bits: [u64; 4],
}

impl Window {
    pub fn is_used(&self, nonce: u64) -> Result<bool, Error> {
        let Some(offset) = nonce.checked_sub(self.base) else {
            return Ok(true);
        };
        let (word, mask) = locate(offset)?;
        let [a, b, c, d] = self.bits;
        let w = match word {
            0 => a,
            1 => b,
            2 => c,
            _ => d,
        };
        Ok(w & mask != 0)
    }

    pub fn consume(&mut self, nonce: u64) -> Result<(), Error> {
        let offset = nonce.checked_sub(self.base).ok_or(Error::NonceUsed)?;
        let (word, mask) = locate(offset)?;
        let [a, b, c, d] = &mut self.bits;
        let slot = match word {
            0 => a,
            1 => b,
            2 => c,
            _ => d,
        };
        if *slot & mask != 0 {
            return Err(Error::NonceUsed);
        }
        *slot |= mask;
        Ok(())
    }

    pub fn advance(&mut self, new_base: u64) -> Result<(), Error> {
        let delta = new_base
            .checked_sub(self.base)
            .filter(|d| *d > 0)
            .ok_or(Error::NonceRegression)?;
        self.bits = match u8::try_from(delta) {
            Ok(d) => shifted(self.bits, d),
            Err(_) => [0; 4],
        };
        self.base = new_base;
        Ok(())
    }

    pub fn next_free(&self) -> Option<u64> {
        let (w, i) = self
            .bits
            .iter()
            .zip(0u64..)
            .find(|(w, _)| **w != u64::MAX)?;
        self.base.checked_add(
            i.wrapping_mul(64)
                .wrapping_add(u64::from(w.trailing_ones())),
        )
    }
}

fn locate(offset: u64) -> Result<(u8, u64), Error> {
    let off = u8::try_from(offset).map_err(|_| Error::NonceOutOfWindow)?;
    Ok((off / 64, 1u64.rotate_left(u32::from(off % 64))))
}

fn shifted(old: [u64; 4], delta: u8) -> [u64; 4] {
    let words = usize::from(delta / 64);
    let shift = u32::from(delta % 64);
    let limb = |i: usize| old.get(i.wrapping_add(words)).copied().unwrap_or(0);
    let mut out = [0u64; 4];
    for (i, slot) in out.iter_mut().enumerate() {
        let low = limb(i).wrapping_shr(shift);
        let high = limb(i.wrapping_add(1))
            .checked_shl(64u32.wrapping_sub(shift))
            .unwrap_or(0);
        *slot = low | high;
    }
    out
}
