use intent_core::flash::check_flash_end;
use intent_core::Error;

const PROGRAM: [u8; 32] = [1; 32];
const INTENT: [u8; 32] = [2; 32];
const END: [u8; 8] = [9, 8, 7, 6, 5, 4, 3, 2];

fn row(disc: &[u8], extra: &[u8]) -> Vec<u8> {
    let mut d = disc.to_vec();
    d.extend_from_slice(extra);
    d
}

#[test]
fn the_named_end_row_of_this_program_for_this_intent_is_accepted() {
    assert_eq!(
        check_flash_end(
            &PROGRAM,
            &row(&END, &[0; 8]),
            Some(&INTENT),
            &PROGRAM,
            &END,
            &INTENT
        ),
        Ok(())
    );
    assert_eq!(
        check_flash_end(&PROGRAM, &END, Some(&INTENT), &PROGRAM, &END, &INTENT),
        Ok(())
    );
}

#[test]
fn a_row_of_another_program_is_rejected_first() {
    assert_eq!(
        check_flash_end(
            &[3; 32],
            &row(&END, &[]),
            Some(&INTENT),
            &PROGRAM,
            &END,
            &INTENT
        ),
        Err(Error::FlashEndProgram)
    );
    assert_eq!(
        check_flash_end(&[3; 32], &[], None, &PROGRAM, &END, &INTENT),
        Err(Error::FlashEndProgram)
    );
}

#[test]
fn a_row_that_is_not_end_fill_is_rejected() {
    let mut other = END;
    other[7] ^= 1;
    assert_eq!(
        check_flash_end(
            &PROGRAM,
            &row(&other, &[0; 8]),
            Some(&INTENT),
            &PROGRAM,
            &END,
            &INTENT
        ),
        Err(Error::FlashEndDiscriminator)
    );
    assert_eq!(
        check_flash_end(&PROGRAM, &END[..7], Some(&INTENT), &PROGRAM, &END, &INTENT),
        Err(Error::FlashEndDiscriminator)
    );
    assert_eq!(
        check_flash_end(&PROGRAM, &[], Some(&INTENT), &PROGRAM, &END, &INTENT),
        Err(Error::FlashEndDiscriminator)
    );
}

#[test]
fn an_end_row_for_another_intent_or_without_one_is_rejected() {
    assert_eq!(
        check_flash_end(&PROGRAM, &END, Some(&[4; 32]), &PROGRAM, &END, &INTENT),
        Err(Error::FlashEndIntent)
    );
    assert_eq!(
        check_flash_end(&PROGRAM, &END, None, &PROGRAM, &END, &INTENT),
        Err(Error::FlashEndIntent)
    );
}
