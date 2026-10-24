use anchor_lang::prelude::*;
use intent_core::delivery::FINGERPRINT_LEN;

use crate::delivery::{fingerprint, profile_key};
use crate::errors::EngineError;
use crate::events::CommitteeKeysSynced;
use crate::state::{Committee, COMMITTEE_VERSION, PROFILE_SEED};

#[event_cpi]
#[derive(Accounts)]
pub struct SyncCommitteeKeys<'info> {
    #[account(
        mut,
        constraint = committee.load()?.version == COMMITTEE_VERSION @ EngineError::AccountOutdated
    )]
    pub committee: AccountLoader<'info, Committee>,
}

pub fn handle_sync_committee_keys(ctx: Context<SyncCommitteeKeys>) -> Result<()> {
    let members = {
        let stored = ctx.accounts.committee.load()?;
        stored
            .members
            .iter()
            .take(usize::from(stored.count))
            .copied()
            .collect::<Vec<Pubkey>>()
    };
    require!(
        ctx.remaining_accounts.len() == members.len(),
        EngineError::ProfileMismatch
    );
    let mut mask = 0u8;
    let mut fps = [[0u8; FINGERPRINT_LEN]; intent_core::committee::MAX_MEMBERS];
    for (i, (member, profile)) in members.iter().zip(ctx.remaining_accounts).enumerate() {
        let (expected, _) =
            Pubkey::find_program_address(&[PROFILE_SEED, member.as_ref()], &crate::ID);
        require_keys_eq!(profile.key(), expected, EngineError::ProfileMismatch);
        if let Some(key) = profile_key(profile)? {
            mask |= 1u8
                .checked_shl(u32::try_from(i).map_err(|_| EngineError::Overflow)?)
                .ok_or(EngineError::Overflow)?;
            *fps.get_mut(i).ok_or(EngineError::ProfileMismatch)? = fingerprint(&key);
        }
    }
    {
        let mut stored = ctx.accounts.committee.load_mut()?;
        stored.keys_mask = mask;
        stored.key_fps = fps;
        stored.keys_synced = 1;
    }
    emit_cpi!(CommitteeKeysSynced {
        committee: ctx.accounts.committee.key(),
        mask,
        fingerprints: fps,
    });
    Ok(())
}
