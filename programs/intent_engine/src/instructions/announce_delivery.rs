use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_lang::Discriminator;
use intent_core::delivery::{blob_head, may_announce, AnnState};
use intent_core::kinds::Intent as CoreIntent;
use intent_core::lifecycle::Status;

use crate::claims::slot_of;
use crate::delivery::{
    blob_digest, check_committee_recipients, check_key_recipient, create_pda, profile_key,
};
use crate::errors::{core_err, EngineError};
use crate::events::DeliveryAnnounced;
use crate::policy::check_fills_on;
use crate::roster::check_listed;
use crate::state::{
    Announcement, ClaimBoard, ClaimList, Committee, Config, DeliveryBook, Intent,
    ANNOUNCEMENT_SEED, ANNOUNCEMENT_VERSION, CLAIMS_OPEN, CLAIMS_SEED, CLAIMS_VERSION,
    CLAIM_LIST_SEED, CLAIM_LIST_VERSION, CONFIG_ADDRESS, CONFIG_VERSION, DELIVERY_BOOK_SEED,
    DELIVERY_BOOK_VERSION, INTENT_VERSION, PROFILE_SEED,
};

#[event_cpi]
#[derive(Accounts)]
#[instruction(commitment: [u8; 32], blob: Vec<u8>)]
pub struct AnnounceDelivery<'info> {
    pub worker: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        address = CONFIG_ADDRESS,
        constraint = config.load()?.version == CONFIG_VERSION @ EngineError::AccountOutdated
    )]
    pub config: AccountLoader<'info, Config>,
    #[account(constraint = intent.load()?.version == INTENT_VERSION @ EngineError::AccountOutdated)]
    pub intent: AccountLoader<'info, Intent>,
    /// CHECK: compared with the attestor the intent's params name
    pub attestor: UncheckedAccount<'info>,
    /// CHECK: the attestor's profile address; read only when the program owns it
    #[account(seeds = [PROFILE_SEED, attestor.key().as_ref()], bump)]
    pub judge_profile: Option<UncheckedAccount<'info>>,
    #[account(address = attestor.key() @ EngineError::CommitteeMismatch)]
    pub committee: Option<AccountLoader<'info, Committee>>,
    #[account(
        seeds = [CLAIMS_SEED, intent.key().as_ref()],
        bump = board.load()?.bump,
        constraint = board.load()?.version == CLAIMS_VERSION @ EngineError::AccountOutdated
    )]
    pub board: Option<AccountLoader<'info, ClaimBoard>>,
    #[account(
        seeds = [CLAIM_LIST_SEED, intent.key().as_ref()],
        bump = claim_list.load()?.bump,
        constraint = claim_list.load()?.version == CLAIM_LIST_VERSION @ EngineError::AccountOutdated
    )]
    pub claim_list: Option<AccountLoader<'info, ClaimList>>,
    /// CHECK: the intent's delivery book, created here by its first announcement
    #[account(mut, seeds = [DELIVERY_BOOK_SEED, intent.key().as_ref()], bump)]
    pub book: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = Announcement::SPACE,
        seeds = [ANNOUNCEMENT_SEED, intent.key().as_ref(), worker.key().as_ref(), &blob_digest(&blob)],
        bump
    )]
    pub announcement: AccountLoader<'info, Announcement>,
    /// CHECK: the config's fee recipient wallet, paid the announce fee
    #[account(mut, address = config.load()?.fee_recipient @ EngineError::FeeAccountNotCanonical)]
    pub fee_to: Option<UncheckedAccount<'info>>,
    pub system_program: Program<'info, System>,
}

struct Checked {
    attestor: Pubkey,
    expires_at: i64,
    fee: u64,
}

fn check_intent(ctx: &Context<AnnounceDelivery>, now: i64) -> Result<Checked> {
    let config = ctx.accounts.config.load()?;
    let intent = ctx.accounts.intent.load()?;
    check_fills_on(&config, intent.kind)?;
    let status = Status::try_from(intent.status).map_err(core_err)?;
    require!(
        status == Status::Open && now < intent.expires_at,
        EngineError::InvalidTransition
    );
    require!(intent.agent_fee == 0, EngineError::MandateMismatch);
    let attestor = match CoreIntent::decode(intent.kind, &intent.params).map_err(core_err)? {
        CoreIntent::AttestedResult(p) if p.spec_hash != [0u8; 32] => p.attestor,
        _ => return err!(EngineError::NotAProof),
    };
    require!(
        ctx.accounts.attestor.key().to_bytes() == attestor,
        EngineError::AttestorMismatch
    );
    if intent.claims == CLAIMS_OPEN {
        let board = ctx
            .accounts
            .board
            .as_ref()
            .ok_or(EngineError::ClaimsMissing)?
            .load()?;
        require_keys_eq!(
            board.intent,
            ctx.accounts.intent.key(),
            EngineError::ClaimsMissing
        );
        let worker = ctx.accounts.worker.key();
        may_announce(slot_of(&board, now), worker.to_bytes()).map_err(core_err)?;
        check_listed(&board, ctx.accounts.claim_list.as_ref(), &worker)?;
    }
    Ok(Checked {
        attestor: ctx.accounts.attestor.key(),
        expires_at: intent.expires_at,
        fee: u64::from(config.announce_fee),
    })
}

fn check_recipients(ctx: &Context<AnnounceDelivery>, blob: &[u8]) -> Result<u8> {
    let head = blob_head(blob).map_err(core_err)?;
    if ctx.accounts.attestor.owner == &crate::ID {
        let committee = ctx
            .accounts
            .committee
            .as_ref()
            .ok_or(EngineError::CommitteeMismatch)?
            .load()?;
        check_committee_recipients(&head, &committee)?;
    } else {
        let profile = ctx
            .accounts
            .judge_profile
            .as_ref()
            .ok_or(EngineError::ProfileMismatch)?;
        check_key_recipient(&head, profile_key(&profile.to_account_info())?)?;
    }
    Ok(head.count)
}

fn next_seq(ctx: &Context<AnnounceDelivery>) -> Result<u64> {
    let intent = ctx.accounts.intent.key();
    let book = ctx.accounts.book.to_account_info();
    let created = book.owner != &crate::ID;
    if created {
        create_pda(
            &ctx.accounts.system_program.to_account_info(),
            &ctx.accounts.payer.to_account_info(),
            &book,
            &[DELIVERY_BOOK_SEED, intent.as_ref(), &[ctx.bumps.book]],
            DeliveryBook::SPACE,
        )?;
    }
    let mut data = book.try_borrow_mut_data()?;
    let disc = DeliveryBook::DISCRIMINATOR;
    let (head, body) = data.split_at_mut(disc.len());
    if created {
        head.copy_from_slice(disc);
    }
    require!(
        &*head == disc && body.len() == core::mem::size_of::<DeliveryBook>(),
        EngineError::BookMismatch
    );
    let stored: &mut DeliveryBook =
        bytemuck::try_from_bytes_mut(body).map_err(|_| EngineError::BookMismatch)?;
    if created {
        stored.intent = intent;
        stored.payer = ctx.accounts.payer.key();
        stored.next_seq = 1;
        stored.version = DELIVERY_BOOK_VERSION;
        stored.bump = ctx.bumps.book;
    }
    require_keys_eq!(stored.intent, intent, EngineError::BookMismatch);
    require!(
        stored.version == DELIVERY_BOOK_VERSION,
        EngineError::AccountOutdated
    );
    let seq = stored.next_seq;
    stored.next_seq = seq.checked_add(1).ok_or(EngineError::Overflow)?;
    stored.live = stored.live.checked_add(1).ok_or(EngineError::Overflow)?;
    Ok(seq)
}

pub fn handle_announce_delivery(
    ctx: Context<AnnounceDelivery>,
    commitment: [u8; 32],
    blob: Vec<u8>,
) -> Result<()> {
    let clock = Clock::get()?;
    let checked = check_intent(&ctx, clock.unix_timestamp)?;
    let recipients = check_recipients(&ctx, &blob)?;
    require!(commitment != [0u8; 32], EngineError::CommitmentZero);
    if checked.fee > 0 {
        let fee_to = ctx
            .accounts
            .fee_to
            .as_ref()
            .ok_or(EngineError::AnnounceFeeMissing)?;
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: fee_to.to_account_info(),
                },
            ),
            checked.fee,
        )?;
    }
    let seq = next_seq(&ctx)?;
    let intent = ctx.accounts.intent.key();
    let worker = ctx.accounts.worker.key();
    let payer = ctx.accounts.payer.key();
    {
        let mut stored = ctx.accounts.announcement.load_init()?;
        stored.intent = intent;
        stored.worker = worker;
        stored.attestor = checked.attestor;
        stored.payer = payer;
        stored.commitment = commitment;
        stored.seq = seq;
        stored.slot = clock.slot;
        stored.announced_at = clock.unix_timestamp;
        stored.expires_at = checked.expires_at;
        stored.blob_len = u16::try_from(blob.len()).map_err(|_| EngineError::Overflow)?;
        stored.version = ANNOUNCEMENT_VERSION;
        stored.bump = ctx.bumps.announcement;
        stored.state = u8::from(AnnState::Announced);
        stored.recipients = recipients;
        stored
            .blob
            .get_mut(..blob.len())
            .ok_or(EngineError::BlobMalformed)?
            .copy_from_slice(&blob);
    }
    emit_cpi!(DeliveryAnnounced {
        intent,
        announcement: ctx.accounts.announcement.key(),
        seq,
        worker,
        payer,
        attestor: checked.attestor,
        commitment,
        slot: clock.slot,
        recipients,
    });
    Ok(())
}
