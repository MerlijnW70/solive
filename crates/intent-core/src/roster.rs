use crate::Error;

pub const MAX_CLAIMANTS: usize = 32;

pub type Key = [u8; 32];

pub fn check_size(size: u8, capacity: usize) -> Result<(), Error> {
    let size = usize::from(size);
    if size == 0 || size > capacity || size > MAX_CLAIMANTS {
        return Err(Error::ClaimListInvalid);
    }
    Ok(())
}

pub fn extend<K: Copy + PartialEq + Default>(
    workers: &mut [K],
    count: u8,
    size: u8,
    added: &[K],
) -> Result<u8, Error> {
    check_size(size, workers.len())?;
    let start = usize::from(count);
    let end = start.checked_add(added.len()).ok_or(Error::Overflow)?;
    if end > usize::from(size) {
        return Err(Error::ClaimListInvalid);
    }
    let listed = workers.get(..start).ok_or(Error::ClaimListInvalid)?;
    for (i, worker) in added.iter().enumerate() {
        let earlier = added.get(..i).ok_or(Error::ClaimListInvalid)?;
        if *worker == K::default() || listed.contains(worker) || earlier.contains(worker) {
            return Err(Error::ClaimListInvalid);
        }
    }
    workers
        .get_mut(start..end)
        .ok_or(Error::ClaimListInvalid)?
        .copy_from_slice(added);
    u8::try_from(end).map_err(|_| Error::Overflow)
}

pub fn admits<K: PartialEq>(workers: &[K], count: u8, size: u8, worker: &K) -> Result<(), Error> {
    if count != size {
        return Err(Error::ClaimListIncomplete);
    }
    let listed = workers
        .get(..usize::from(count))
        .ok_or(Error::ClaimListInvalid)?;
    if listed.contains(worker) {
        Ok(())
    } else {
        Err(Error::NotListed)
    }
}
