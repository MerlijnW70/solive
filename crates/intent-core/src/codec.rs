use crate::Error;

pub struct Reader<'a> {
    rest: &'a [u8],
}

impl<'a> Reader<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self { rest: bytes }
    }

    pub fn u64(&mut self) -> Result<u64, Error> {
        self.take().map(u64::from_le_bytes)
    }

    pub fn i64(&mut self) -> Result<i64, Error> {
        self.take().map(i64::from_le_bytes)
    }

    pub fn key(&mut self) -> Result<[u8; 32], Error> {
        let (head, tail) = self
            .rest
            .split_first_chunk::<32>()
            .ok_or(Error::Truncated)?;
        self.rest = tail;
        Ok(*head)
    }

    pub fn finish(self) -> Result<(), Error> {
        if self.rest.iter().all(|b| *b == 0) {
            Ok(())
        } else {
            Err(Error::NonCanonical)
        }
    }

    fn take(&mut self) -> Result<[u8; 8], Error> {
        let (head, tail) = self.rest.split_first_chunk::<8>().ok_or(Error::Truncated)?;
        self.rest = tail;
        Ok(*head)
    }
}

pub struct Writer<'a> {
    rest: &'a mut [u8],
}

impl<'a> Writer<'a> {
    pub fn new(bytes: &'a mut [u8]) -> Self {
        Self { rest: bytes }
    }

    pub fn u64(self, v: u64) -> Result<Self, Error> {
        self.put(v.to_le_bytes())
    }

    pub fn i64(self, v: i64) -> Result<Self, Error> {
        self.put(v.to_le_bytes())
    }

    pub fn key(self, v: &[u8; 32]) -> Result<Self, Error> {
        let (head, tail) = self
            .rest
            .split_first_chunk_mut::<32>()
            .ok_or(Error::Truncated)?;
        *head = *v;
        Ok(Self { rest: tail })
    }

    fn put(self, bytes: [u8; 8]) -> Result<Self, Error> {
        let (head, tail) = self
            .rest
            .split_first_chunk_mut::<8>()
            .ok_or(Error::Truncated)?;
        *head = bytes;
        Ok(Self { rest: tail })
    }
}
