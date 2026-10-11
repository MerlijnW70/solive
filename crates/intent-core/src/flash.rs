use crate::Error;

pub fn check_flash_end(
    row_program: &[u8; 32],
    row_data: &[u8],
    row_intent: Option<&[u8; 32]>,
    program: &[u8; 32],
    end_discriminator: &[u8],
    intent: &[u8; 32],
) -> Result<(), Error> {
    if row_program != program {
        return Err(Error::FlashEndProgram);
    }
    if row_data.get(..end_discriminator.len()) != Some(end_discriminator) {
        return Err(Error::FlashEndDiscriminator);
    }
    if row_intent != Some(intent) {
        return Err(Error::FlashEndIntent);
    }
    Ok(())
}
