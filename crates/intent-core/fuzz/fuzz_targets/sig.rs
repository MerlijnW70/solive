#![no_main]

use intent_core::sig::{check_ed25519_ix, ed25519_header, ED25519_PROGRAM_ID};
use libfuzzer_sys::fuzz_target;

fuzz_target!(|input: (bool, [u8; 32], Vec<u8>, [u8; 32], Vec<u8>, [u8; 64])| {
    let (real_program, other_program, data, pubkey, message, signature) = input;
    let program = if real_program { ED25519_PROGRAM_ID } else { other_program };

    if check_ed25519_ix(&program, &data, &pubkey, &message).is_ok() {
        assert_eq!(program, ED25519_PROGRAM_ID);
        let len = u16::try_from(message.len()).expect("accepted message fits u16");
        assert_eq!(data.len(), 112 + message.len());
        assert_eq!(&data[..16], &ed25519_header(len)[..]);
        assert_eq!(&data[16..48], &pubkey[..]);
        assert_eq!(&data[112..], &message[..]);
    }

    if let Ok(len) = u16::try_from(message.len()) {
        let mut canonical = ed25519_header(len).to_vec();
        canonical.extend_from_slice(&pubkey);
        canonical.extend_from_slice(&signature);
        canonical.extend_from_slice(&message);
        assert_eq!(
            check_ed25519_ix(&ED25519_PROGRAM_ID, &canonical, &pubkey, &message),
            Ok(())
        );
    }
});
