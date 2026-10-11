use solana_account_info::AccountInfo;
use solana_address::Address;
use solana_cpi::invoke;
use solana_instruction::{AccountMeta, Instruction};
use solana_program_entrypoint::{entrypoint, ProgramResult};

entrypoint!(relay);

pub fn relay(_program: &Address, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let Some((target, rest)) = accounts.split_first() else {
        return Ok(());
    };
    if !target.executable {
        return Ok(());
    }
    let metas = rest
        .iter()
        .map(|a| AccountMeta {
            pubkey: *a.key,
            is_signer: a.is_signer,
            is_writable: a.is_writable,
        })
        .collect();
    invoke(
        &Instruction {
            program_id: *target.key,
            accounts: metas,
            data: data.to_vec(),
        },
        rest,
    )
}
