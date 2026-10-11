#![no_main]

use intent_core::ext::{check_flags, partner, KNOWN_FLAGS, MAX_PARTNER_BPS, PARTNER_LEN, PARTNER_TAG};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|input: (Vec<u8>, u16, [u8; 32], u16)| {
    let (ext, flags, key, bps) = input;
    assert_eq!(check_flags(flags).is_ok(), flags & !KNOWN_FLAGS == 0);
    match partner(&ext) {
        Ok(Some(p)) => {
            assert!(p.key != [0; 32]);
            assert!(p.bps >= 1 && p.bps <= MAX_PARTNER_BPS);
            let mut canonical = vec![PARTNER_TAG];
            canonical.extend_from_slice(&u16::try_from(PARTNER_LEN).unwrap().to_le_bytes());
            canonical.extend_from_slice(&p.key);
            canonical.extend_from_slice(&p.bps.to_le_bytes());
            assert_eq!(ext, canonical);
        }
        Ok(None) => assert!(ext.is_empty()),
        Err(_) => {}
    }
    let mut built = vec![PARTNER_TAG];
    built.extend_from_slice(&u16::try_from(PARTNER_LEN).unwrap().to_le_bytes());
    built.extend_from_slice(&key);
    built.extend_from_slice(&bps.to_le_bytes());
    let ok = key != [0; 32] && bps >= 1 && bps <= MAX_PARTNER_BPS;
    match partner(&built) {
        Ok(Some(p)) => assert!(ok && p.key == key && p.bps == bps),
        Ok(None) => unreachable!(),
        Err(_) => assert!(!ok),
    }
});
