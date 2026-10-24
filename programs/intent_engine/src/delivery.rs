use anchor_lang::prelude::*;
use anchor_lang::system_program::{
    allocate, assign, create_account, transfer, Allocate, Assign, CreateAccount, Transfer,
};
use anchor_lang::Discriminator;
use intent_core::delivery::{fingerprint_preimage, BlobHead, FINGERPRINT_LEN};

use crate::errors::EngineError;
use crate::state::{Committee, Profile, COMMITTEE_VERSION, PROFILE_VERSION};

pub fn fingerprint(key: &[u8; 32]) -> [u8; FINGERPRINT_LEN] {
    let digest = solana_sha256_hasher::hashv(&[&fingerprint_preimage(key)]).to_bytes();
    let mut fp = [0u8; FINGERPRINT_LEN];
    for (dst, src) in fp.iter_mut().zip(digest.iter()) {
        *dst = *src;
    }
    fp
}

pub fn create_pda<'info>(
    system_program: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    account: &AccountInfo<'info>,
    seeds: &[&[u8]],
    space: usize,
) -> Result<()> {
    let signer = &[seeds];
    let program = system_program.key();
    let need = Rent::get()?.minimum_balance(space);
    let size = u64::try_from(space).map_err(|_| EngineError::Overflow)?;
    let have = account.lamports();
    if have == 0 {
        return create_account(
            CpiContext::new_with_signer(
                program,
                CreateAccount {
                    from: payer.clone(),
                    to: account.clone(),
                },
                signer,
            ),
            need,
            size,
            &crate::ID,
        );
    }
    let top_up = need.saturating_sub(have);
    if top_up > 0 {
        transfer(
            CpiContext::new(
                program,
                Transfer {
                    from: payer.clone(),
                    to: account.clone(),
                },
            ),
            top_up,
        )?;
    }
    allocate(
        CpiContext::new_with_signer(
            program,
            Allocate {
                account_to_allocate: account.clone(),
            },
            signer,
        ),
        size,
    )?;
    assign(
        CpiContext::new_with_signer(
            program,
            Assign {
                account_to_assign: account.clone(),
            },
            signer,
        ),
        &crate::ID,
    )
}

pub fn profile_key(profile: &AccountInfo) -> Result<Option<[u8; 32]>> {
    if profile.owner != &crate::ID {
        return Ok(None);
    }
    let data = profile.try_borrow_data()?;
    let disc = Profile::DISCRIMINATOR;
    require!(
        data.get(..disc.len()) == Some(disc) && data.len() == Profile::SPACE,
        EngineError::ProfileMismatch
    );
    let body = data
        .get(disc.len()..Profile::SPACE)
        .ok_or(EngineError::ProfileMismatch)?;
    let stored: &Profile =
        bytemuck::try_from_bytes(body).map_err(|_| EngineError::ProfileMismatch)?;
    require!(
        stored.version == PROFILE_VERSION,
        EngineError::AccountOutdated
    );
    Ok((stored.encryption_key != [0u8; 32]).then_some(stored.encryption_key))
}

pub fn check_key_recipient(head: &BlobHead, key: Option<[u8; 32]>) -> Result<()> {
    require!(head.count == 1, EngineError::BlobRecipients);
    match key {
        Some(key) => {
            require!(head.mask == 1, EngineError::BlobKeyMismatch);
            require!(
                head.fps.first() == Some(&fingerprint(&key)),
                EngineError::BlobKeyMismatch
            );
        }
        None => require!(head.mask == 0, EngineError::BlobKeyMismatch),
    }
    Ok(())
}

pub fn check_committee_recipients(head: &BlobHead, committee: &Committee) -> Result<()> {
    require!(
        committee.version == COMMITTEE_VERSION,
        EngineError::AccountOutdated
    );
    require!(
        committee.keys_synced == 1,
        EngineError::CommitteeKeysUnsynced
    );
    require!(head.count == committee.count, EngineError::BlobRecipients);
    require!(
        head.mask == committee.keys_mask,
        EngineError::BlobKeyMismatch
    );
    for (i, (fp, stored)) in head
        .fps
        .iter()
        .zip(committee.key_fps.iter())
        .take(usize::from(head.count))
        .enumerate()
    {
        let profiled = (u32::from(head.mask) >> i) & 1 == 1;
        require!(!profiled || fp == stored, EngineError::BlobKeyMismatch);
    }
    Ok(())
}

pub fn intent_open(intent: &AccountInfo, now: i64) -> Result<bool> {
    if intent.owner != &crate::ID {
        return Ok(false);
    }
    let data = intent.try_borrow_data()?;
    let disc = crate::state::Intent::DISCRIMINATOR;
    if data.get(..disc.len()) != Some(disc) || data.len() != crate::state::Intent::SPACE {
        return Ok(false);
    }
    let body = data
        .get(disc.len()..crate::state::Intent::SPACE)
        .ok_or(EngineError::AnnouncementMismatch)?;
    let stored: &crate::state::Intent =
        bytemuck::try_from_bytes(body).map_err(|_| EngineError::AnnouncementMismatch)?;
    require!(
        stored.version == crate::state::INTENT_VERSION,
        EngineError::AccountOutdated
    );
    let open = intent_core::lifecycle::Status::try_from(stored.status)
        .map_err(crate::errors::core_err)?
        == intent_core::lifecycle::Status::Open;
    Ok(open && now < stored.expires_at)
}
