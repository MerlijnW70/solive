use intent_core::flash::check_flash_end;

#[kani::proof]
#[kani::unwind(34)]
fn a_flash_fill_closes_only_on_this_programs_end_for_this_intent() {
    let row_program: [u8; 32] = kani::any();
    let program: [u8; 32] = kani::any();
    let data: [u8; 12] = kani::any();
    let len: usize = kani::any();
    kani::assume(len <= data.len());
    let disc: [u8; 8] = kani::any();
    let intent: [u8; 32] = kani::any();
    let row_intent: [u8; 32] = kani::any();
    let named: bool = kani::any();
    let ok = check_flash_end(
        &row_program,
        &data[..len],
        named.then_some(&row_intent),
        &program,
        &disc,
        &intent,
    )
    .is_ok();
    assert_eq!(
        ok,
        row_program == program && len >= 8 && data[..8] == disc && named && row_intent == intent
    );
}
