use super::*;

pub fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &intent_engine::ID).0
}

pub fn config_pda() -> Pubkey {
    pda(&[CONFIG_SEED])
}

pub fn user_pda(owner: &Pubkey) -> Pubkey {
    pda(&[USER_SEED, owner.as_ref()])
}

pub fn intent_pda(owner: &Pubkey, nonce: u64) -> Pubkey {
    pda(&[INTENT_SEED, owner.as_ref(), &nonce.to_le_bytes()])
}

pub fn vault_pda(intent: &Pubkey) -> Pubkey {
    pda(&[VAULT_SEED, intent.as_ref()])
}

pub fn event_authority() -> Pubkey {
    pda(&[b"__event_authority"])
}

pub fn program_data_address() -> Pubkey {
    Pubkey::find_program_address(&[intent_engine::ID.as_ref()], &bpf_loader_upgradeable::ID).0
}

pub fn canonical_refund(owner: &Pubkey, market: &Market) -> Pubkey {
    anchor_spl::associated_token::get_associated_token_address_with_program_id(
        owner,
        &market.input_mint,
        &market.input_program,
    )
}

pub fn delegate_pda(owner: &Pubkey) -> Pubkey {
    pda(&[DELEGATE_SEED, owner.as_ref()])
}
