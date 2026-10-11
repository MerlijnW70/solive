use intent_core::codec::{Reader, Writer};
use intent_core::Error;

#[test]
fn reader_decodes_little_endian_in_order() {
    let bytes = [
        1, 0, 0, 0, 0, 0, 0, 0, 0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    ];
    let mut r = Reader::new(&bytes);
    assert_eq!(r.u64(), Ok(1));
    assert_eq!(r.i64(), Ok(-2));
    assert_eq!(r.u64(), Err(Error::Truncated));
    assert_eq!(r.finish(), Ok(()));
}

#[test]
fn reader_rejects_short_input() {
    let bytes = [0u8; 7];
    assert_eq!(Reader::new(&bytes).u64(), Err(Error::Truncated));
    assert_eq!(Reader::new(&bytes).i64(), Err(Error::Truncated));
}

#[test]
fn finish_accepts_only_zero_tail() {
    assert_eq!(Reader::new(&[]).finish(), Ok(()));
    assert_eq!(Reader::new(&[0, 0, 0]).finish(), Ok(()));
    assert_eq!(Reader::new(&[0, 0, 1]).finish(), Err(Error::NonCanonical));
    assert_eq!(Reader::new(&[0x80]).finish(), Err(Error::NonCanonical));
}

#[test]
fn finish_checks_bytes_after_consumed_fields() -> Result<(), Error> {
    let bytes = [9, 0, 0, 0, 0, 0, 0, 0, 0];
    let mut r = Reader::new(&bytes);
    assert_eq!(r.u64()?, 9);
    r.finish()
}

#[test]
fn writer_round_trips_through_reader() -> Result<(), Error> {
    let mut buf = [0xaau8; 17];
    Writer::new(&mut buf).u64(0x0102_0304_0506_0708)?.i64(-3)?;
    assert_eq!(
        buf,
        [8, 7, 6, 5, 4, 3, 2, 1, 0xfd, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xaa]
    );
    let mut r = Reader::new(&buf);
    assert_eq!(r.u64()?, 0x0102_0304_0506_0708);
    assert_eq!(r.i64()?, -3);
    Ok(())
}

#[test]
fn writer_rejects_short_buffer() {
    let mut buf = [0u8; 7];
    assert!(matches!(
        Writer::new(&mut buf).u64(1),
        Err(Error::Truncated)
    ));
    assert!(matches!(
        Writer::new(&mut buf).i64(1),
        Err(Error::Truncated)
    ));
    assert_eq!(buf, [0u8; 7]);
}

#[test]
fn writer_rejects_second_field_past_end() -> Result<(), Error> {
    let mut buf = [0u8; 15];
    let w = Writer::new(&mut buf).u64(u64::MAX)?;
    assert!(matches!(w.u64(1), Err(Error::Truncated)));
    assert_eq!(
        buf,
        [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0]
    );
    Ok(())
}
