#![no_main]

use intent_core::ext::{find, validate, EXT_MAX_LEN};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|input: (Vec<u8>, Vec<u8>)| {
    let (ext, known) = input;
    if validate(&ext, &known).is_ok() {
        assert!(ext.len() <= EXT_MAX_LEN);
        let mut rebuilt = Vec::new();
        let mut last = 0u8;
        let mut rest = &ext[..];
        while let Some((&tag, after)) = rest.split_first() {
            assert!(tag > last);
            assert!(known.contains(&tag));
            let len = usize::from(u16::from_le_bytes([after[0], after[1]]));
            let value = &after[2..2 + len];
            assert_eq!(find(&ext, &known, tag), Ok(Some(value)));
            rebuilt.push(tag);
            rebuilt.extend_from_slice(&after[..2]);
            rebuilt.extend_from_slice(value);
            last = tag;
            rest = &after[2 + len..];
        }
        assert_eq!(rebuilt, ext);
    }
});
