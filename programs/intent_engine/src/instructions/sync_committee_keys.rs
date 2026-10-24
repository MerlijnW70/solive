use anchor_lang::prelude::*;
use intent_core::committee::MAX_MEMBERS;
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
    /// CHECK: member 0's profile address, checked against the address its wallet derives
    pub profile0: Option<UncheckedAccount<'info>>,
    /// CHECK: member 1's profile address, checked against the address its wallet derives
    pub profile1: Option<UncheckedAccount<'info>>,
    /// CHECK: member 2's profile address, checked against the address its wallet derives
    pub profile2: Option<UncheckedAccount<'info>>,
    /// CHECK: member 3's profile address, checked against the address its wallet derives
    pub profile3: Option<UncheckedAccount<'info>>,
    /// CHECK: member 4's profile address, checked against the address its wallet derives
    pub profile4: Option<UncheckedAccount<'info>>,
    /// CHECK: member 5's profile address, checked against the address its wallet derives
    pub profile5: Option<UncheckedAccount<'info>>,
    /// CHECK: member 6's profile address, checked against the address its wallet derives
    pub profile6: Option<UncheckedAccount<'info>>,
    /// CHECK: member 7's profile address, checked against the address its wallet derives
    pub profile7: Option<UncheckedAccount<'info>>,
}

pub fn handle_sync_committee_keys(ctx: Context<SyncCommitteeKeys>) -> Result<()> {
    let (members, count) = {
        let stored = ctx.accounts.committee.load()?;
        (stored.members, usize::from(stored.count))
    };
    let accounts = &ctx.accounts;
    let slots = [
        &accounts.profile0,
        &accounts.profile1,
        &accounts.profile2,
        &accounts.profile3,
        &accounts.profile4,
        &accounts.profile5,
        &accounts.profile6,
        &accounts.profile7,
    ];
    let mut mask = 0u8;
    let mut fps = [[0u8; FINGERPRINT_LEN]; MAX_MEMBERS];
    for (i, ((slot, member), fp)) in slots
        .iter()
        .zip(members.iter())
        .zip(fps.iter_mut())
        .enumerate()
    {
        let Some(profile) = slot.as_ref() else {
            require!(i >= count, EngineError::ProfileMismatch);
            continue;
        };
        require!(i < count, EngineError::ProfileMismatch);
        let (expected, _) =
            Pubkey::find_program_address(&[PROFILE_SEED, member.as_ref()], &crate::ID);
        require_keys_eq!(profile.key(), expected, EngineError::ProfileMismatch);
        if let Some(key) = profile_key(&profile.to_account_info())? {
            mask |= 1u8
                .checked_shl(u32::try_from(i).map_err(|_| EngineError::Overflow)?)
                .ok_or(EngineError::Overflow)?;
            *fp = fingerprint(&key);
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
