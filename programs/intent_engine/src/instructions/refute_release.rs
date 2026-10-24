use anchor_lang::prelude::*;
use intent_core::delivery::{
    commitment_preimage, refutes, split_hash_preimage, AnnState, SALT_LEN,
};

use crate::attested::SplitClaim;
use crate::errors::{core_err, EngineError};
use crate::events::ReleaseRefuted;
use crate::state::{
    Announcement, Refutation, ANNOUNCEMENT_VERSION, REFUTATION_SEED, REFUTATION_VERSION,
};

#[event_cpi]
#[derive(Accounts)]
pub struct RefuteRelease<'info> {
    pub earlier_worker: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(constraint = paid.load()?.version == ANNOUNCEMENT_VERSION @ EngineError::AccountOutdated)]
    pub paid: AccountLoader<'info, Announcement>,
    #[account(constraint = earlier.load()?.version == ANNOUNCEMENT_VERSION @ EngineError::AccountOutdated)]
    pub earlier: AccountLoader<'info, Announcement>,
    #[account(
        init,
        payer = payer,
        space = Refutation::SPACE,
        seeds = [REFUTATION_SEED, earlier.key().as_ref()],
        bump
    )]
    pub refutation: AccountLoader<'info, Refutation>,
    pub system_program: Program<'info, System>,
}

fn payees_of(paid: &Announcement, claim: Option<&SplitClaim>) -> Result<Vec<[u8; 32]>> {
    if paid.split_hash == [0u8; 32] {
        return Ok(vec![paid.worker.to_bytes()]);
    }
    let claim = claim.ok_or(EngineError::RefuteSplitMismatch)?;
    let wallets: Vec<[u8; 32]> = claim.recipients.iter().map(Pubkey::to_bytes).collect();
    let (buf, used) = split_hash_preimage(&wallets, &claim.weights).map_err(core_err)?;
    let hash =
        solana_sha256_hasher::hashv(&[buf.get(..used).ok_or(EngineError::RefuteSplitMismatch)?])
            .to_bytes();
    require!(hash == paid.split_hash, EngineError::RefuteSplitMismatch);
    Ok(wallets)
}

pub fn handle_refute_release(
    ctx: Context<RefuteRelease>,
    salt: [u8; SALT_LEN],
    esk: [u8; 32],
    claim: Option<SplitClaim>,
) -> Result<()> {
    let clock = Clock::get()?;
    let paid = ctx.accounts.paid.load()?;
    let earlier = ctx.accounts.earlier.load()?;
    require!(
        AnnState::try_from(paid.state).map_err(core_err)? == AnnState::Paid,
        EngineError::RefuteNotPaid
    );
    require_keys_eq!(
        earlier.intent,
        paid.intent,
        EngineError::AnnouncementMismatch
    );
    require_keys_eq!(
        earlier.worker,
        ctx.accounts.earlier_worker.key(),
        EngineError::RefuteNotAnnouncer
    );
    let payees = payees_of(&paid, claim.as_ref())?;
    refutes(earlier.seq, paid.seq, earlier.worker.to_bytes(), &payees).map_err(core_err)?;
    let preimage = commitment_preimage(
        &earlier.intent.to_bytes(),
        &earlier.worker.to_bytes(),
        &salt,
        &paid.delivered,
    );
    require!(
        solana_sha256_hasher::hashv(&[&preimage]).to_bytes() == earlier.commitment,
        EngineError::CommitmentMismatch
    );
    let refuter = ctx.accounts.earlier_worker.key();
    {
        let mut stored = ctx.accounts.refutation.load_init()?;
        stored.intent = paid.intent;
        stored.attestor = paid.attestor;
        stored.paid_announcement = ctx.accounts.paid.key();
        stored.earlier_announcement = ctx.accounts.earlier.key();
        stored.paid_worker = paid.worker;
        stored.earlier_worker = earlier.worker;
        stored.refuter = refuter;
        stored.delivered = paid.delivered;
        stored.split_hash = paid.split_hash;
        stored.earlier_commitment = earlier.commitment;
        stored.esk = esk;
        stored.paid_seq = paid.seq;
        stored.earlier_seq = earlier.seq;
        stored.refuted_at = clock.unix_timestamp;
        stored.slot = clock.slot;
        stored.salt = salt;
        stored.blob_len = earlier.blob_len;
        stored.version = REFUTATION_VERSION;
        stored.bump = ctx.bumps.refutation;
        stored.recipients = earlier.recipients;
        stored.blob.copy_from_slice(&earlier.blob);
    }
    emit_cpi!(ReleaseRefuted {
        intent: paid.intent,
        attestor: paid.attestor,
        refutation: ctx.accounts.refutation.key(),
        paid_announcement: ctx.accounts.paid.key(),
        paid_seq: paid.seq,
        paid_worker: paid.worker,
        earlier_announcement: ctx.accounts.earlier.key(),
        earlier_seq: earlier.seq,
        earlier_worker: earlier.worker,
        delivered: paid.delivered,
        refuter,
    });
    Ok(())
}
