use anchor_lang::prelude::*;
use intent_core::committee::COMMITTEE_COSIGN_TAG;
use intent_core::delivery::AnnState;
use intent_core::kinds::Intent as CoreIntent;
use intent_core::lifecycle::Status;
use intent_core::sig::{offchain_envelope, RejectDelivery};

use crate::attested::Judge;
use crate::claims::{claim_of, pay_to, read_board, stored_bump, write_board};
use crate::errors::{core_err, EngineError};
use crate::events::{DeliveryRejected, StakeMoved};
use crate::policy::{verify_preceding_cosign, verify_preceding_ed25519};
use crate::state::{
    Announcement, Committee, Config, Intent, ANNOUNCEMENT_VERSION, CLAIMS_OPEN, CLAIMS_SEED,
    CONFIG_ADDRESS, CONFIG_VERSION, INTENT_VERSION,
};

#[event_cpi]
#[derive(Accounts)]
pub struct RejectDeliveryAccounts<'info> {
    #[account(
        address = CONFIG_ADDRESS,
        constraint = config.load()?.version == CONFIG_VERSION @ EngineError::AccountOutdated
    )]
    pub config: AccountLoader<'info, Config>,
    #[account(constraint = intent.load()?.version == INTENT_VERSION @ EngineError::AccountOutdated)]
    pub intent: AccountLoader<'info, Intent>,
    #[account(
        mut,
        constraint = announcement.load()?.version == ANNOUNCEMENT_VERSION @ EngineError::AccountOutdated
    )]
    pub announcement: AccountLoader<'info, Announcement>,
    /// CHECK: compared with the attestor the intent's params name
    pub attestor: UncheckedAccount<'info>,
    #[account(address = attestor.key() @ EngineError::CommitteeMismatch)]
    pub committee: Option<AccountLoader<'info, Committee>>,
    /// CHECK: the intent's claims board in its current or an earlier layout, read by hand
    #[account(
        mut,
        seeds = [CLAIMS_SEED, intent.key().as_ref()],
        bump = stored_bump(board)?
    )]
    pub board: Option<UncheckedAccount<'info>>,
    /// CHECK: receives the reviewed holder's stake; matched against the board's worker
    #[account(mut)]
    pub stake_to: Option<UncheckedAccount<'info>>,
    /// CHECK: read only through the checked instructions-sysvar loaders
    pub instructions: UncheckedAccount<'info>,
}

struct Target {
    attestor: Pubkey,
    claims: u8,
    domain: [u8; 32],
    seq: u64,
    worker: Pubkey,
}

fn check(ctx: &Context<RejectDeliveryAccounts>, now: i64) -> Result<Target> {
    let domain = ctx.accounts.config.load()?.domain;
    let intent = ctx.accounts.intent.load()?;
    let status = Status::try_from(intent.status).map_err(core_err)?;
    require!(
        status == Status::Open && now < intent.expires_at,
        EngineError::InvalidTransition
    );
    let stored = ctx.accounts.announcement.load()?;
    require_keys_eq!(
        stored.intent,
        ctx.accounts.intent.key(),
        EngineError::AnnouncementMismatch
    );
    require!(
        AnnState::try_from(stored.state).map_err(core_err)? == AnnState::Announced,
        EngineError::DeliveryNotPending
    );
    let attestor = match CoreIntent::decode(intent.kind, &intent.params).map_err(core_err)? {
        CoreIntent::AttestedResult(p) if p.spec_hash != [0u8; 32] => p.attestor,
        _ => return err!(EngineError::NotAProof),
    };
    require!(
        ctx.accounts.attestor.key().to_bytes() == attestor,
        EngineError::AttestorMismatch
    );
    Ok(Target {
        attestor: ctx.accounts.attestor.key(),
        claims: intent.claims,
        domain,
        seq: stored.seq,
        worker: stored.worker,
    })
}

fn verify(ctx: &Context<RejectDeliveryAccounts>, target: &Target, signers_mask: u8) -> Result<()> {
    let preimage = RejectDelivery {
        program: crate::ID.to_bytes(),
        domain: target.domain,
        intent: ctx.accounts.intent.key().to_bytes(),
        announcement: ctx.accounts.announcement.key().to_bytes(),
        seq: target.seq,
    }
    .preimage();
    let instructions = ctx.accounts.instructions.to_account_info();
    if ctx.accounts.attestor.owner == &crate::ID {
        let committee = ctx
            .accounts
            .committee
            .as_ref()
            .ok_or(EngineError::CommitteeMismatch)?;
        let judge = Judge::committee(committee, signers_mask)?;
        let signers = judge.signers(&target.attestor)?;
        verify_preceding_cosign(
            &instructions,
            &judge.eligible(&target.attestor),
            &signers,
            &solana_sha256_hasher::hashv(&[&COMMITTEE_COSIGN_TAG, &preimage]).to_bytes(),
        )
    } else {
        verify_preceding_ed25519(
            &instructions,
            &target.attestor,
            &offchain_envelope(
                &target.attestor.to_bytes(),
                &solana_sha256_hasher::hashv(&[&preimage]).to_bytes(),
            ),
        )
    }
}

fn end_review(
    ctx: &Context<RejectDeliveryAccounts>,
    target: &Target,
    now: i64,
) -> Result<Option<StakeMoved>> {
    if target.claims != CLAIMS_OPEN {
        return Ok(None);
    }
    let board = ctx
        .accounts
        .board
        .as_ref()
        .ok_or(EngineError::ClaimsMissing)?
        .to_account_info();
    let stored = read_board(&board, true)?;
    if stored.review_ann != ctx.accounts.announcement.key() {
        return Ok(None);
    }
    let payout = claim_of(&stored).on_reject(now).map_err(core_err)?;
    let stake_to = ctx.accounts.stake_to.as_ref().map(|a| a.to_account_info());
    let (to, role) = pay_to(&board, &stored, stake_to.as_ref(), payout)?;
    let review_until = stored.review_until;
    write_board(&board, |b| {
        b.worker = Pubkey::default();
        b.held = 0;
        b.dropped_by = stored.worker;
        b.until = review_until;
        b.review_ann = Pubkey::default();
        b.review_until = 0;
    })?;
    Ok(Some(StakeMoved {
        intent: stored.intent,
        worker: stored.worker,
        to,
        amount: payout.amount,
        role,
    }))
}

pub fn handle_reject_delivery(
    ctx: Context<RejectDeliveryAccounts>,
    signers_mask: u8,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let target = check(&ctx, now)?;
    verify(&ctx, &target, signers_mask)?;
    let moved = end_review(&ctx, &target, now)?;
    ctx.accounts.announcement.load_mut()?.state = u8::from(AnnState::Rejected);
    emit_cpi!(DeliveryRejected {
        intent: ctx.accounts.intent.key(),
        announcement: ctx.accounts.announcement.key(),
        seq: target.seq,
        worker: target.worker,
        attestor: target.attestor,
        under_review: moved.is_some(),
        stake_returned: moved.as_ref().map_or(0, |m| m.amount),
    });
    if let Some(moved) = moved {
        emit_cpi!(moved);
    }
    Ok(())
}
