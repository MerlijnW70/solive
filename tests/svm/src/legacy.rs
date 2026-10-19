use super::*;

pub struct LegacyClose {
    pub account: Pubkey,
    pub payee: Pubkey,
    pub with_config: bool,
    pub vault: Option<Pubkey>,
    pub stake_to: Option<Pubkey>,
    pub intent: Option<Pubkey>,
    pub fee_to: Option<Pubkey>,
}

pub fn close_legacy_full_ix(close: &LegacyClose) -> Instruction {
    engine_ix(
        intent_engine::accounts::CloseLegacy {
            account: close.account,
            payee: close.payee,
            config: close.with_config.then(config_pda),
            vault: close.vault,
            stake_to: close.stake_to,
            intent: close.intent,
            fee_to: close.fee_to,
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::CloseLegacy {},
    )
}

pub fn close_legacy_ix(account: &Pubkey, payee: &Pubkey, with_config: bool) -> Instruction {
    close_legacy_full_ix(&LegacyClose {
        account: *account,
        payee: *payee,
        with_config,
        vault: None,
        stake_to: None,
        intent: None,
        fee_to: None,
    })
}
