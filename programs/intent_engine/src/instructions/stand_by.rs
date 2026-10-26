use anchor_lang::prelude::*;
use anchor_lang::system_program::{allocate, assign, create_account, transfer};
use anchor_lang::system_program::{Allocate, Assign, CreateAccount, Transfer};
use anchor_lang::Discriminator;
use intent_core::claim::{Slot, Terms};
use intent_core::lifecycle::Status;

use crate::claims::{line_of, slot_of, standby_address};
use crate::errors::{core_err, EngineError};
use crate::events::StoodBy;
use crate::policy::check_fills_on;
use crate::roster::check_listed;
use crate::state::{
    ClaimBoard, ClaimList, Config, Intent, Standby, CLAIMS_OPEN, CLAIMS_SEED, CLAIMS_VERSION,
    CLAIM_LIST_SEED, CLAIM_LIST_VERSION, CONFIG_ADDRESS, CONFIG_VERSION, INTENT_VERSION,
    STANDBY_SEED, STANDBY_VERSION,
};

#[event_cpi]
#[derive(Accounts)]
pub struct StandBy<'info> {
    #[account(mut)]
    pub worker: Signer<'info>,
    #[account(constraint = intent.load()?.version == INTENT_VERSION @ EngineError::AccountOutdated)]
    pub intent: AccountLoader<'info, Intent>,
    #[account(
        mut,
        seeds = [CLAIMS_SEED, intent.key().as_ref()],
        bump = board.load()?.bump,
        constraint = board.load()?.version == CLAIMS_VERSION @ EngineError::AccountOutdated
    )]
    pub board: AccountLoader<'info, ClaimBoard>,
    /// CHECK: the entry at the line's tail, checked against the address its sequence derives and created here
    #[account(mut)]
    pub entry: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    #[account(
        address = CONFIG_ADDRESS,
        constraint = config.load()?.version == CONFIG_VERSION @ EngineError::AccountOutdated
    )]
    pub config: AccountLoader<'info, Config>,
    #[account(
        seeds = [CLAIM_LIST_SEED, intent.key().as_ref()],
        bump = claim_list.load()?.bump,
        constraint = claim_list.load()?.version == CLAIM_LIST_VERSION @ EngineError::AccountOutdated
    )]
    pub claim_list: Option<AccountLoader<'info, ClaimList>>,
}

fn create_entry(ctx: &Context<StandBy>, seq: u32, bump: u8, stake: u64) -> Result<()> {
    let intent = ctx.accounts.intent.key();
    let seq_bytes = seq.to_le_bytes();
    let seeds: &[&[u8]] = &[STANDBY_SEED, intent.as_ref(), &seq_bytes, &[bump]];
    let signer = &[seeds];
    let program = ctx.accounts.system_program.key();
    let worker = ctx.accounts.worker.to_account_info();
    let entry = ctx.accounts.entry.to_account_info();
    let space = Standby::SPACE as u64;
    let need = Rent::get()?
        .minimum_balance(Standby::SPACE)
        .checked_add(stake)
        .ok_or(EngineError::Overflow)?;
    let have = entry.lamports();
    if have == 0 {
        return create_account(
            CpiContext::new_with_signer(
                program,
                CreateAccount {
                    from: worker,
                    to: entry,
                },
                signer,
            ),
            need,
            space,
            &crate::ID,
        );
    }
    let top_up = need.saturating_sub(have);
    if top_up > 0 {
        transfer(
            CpiContext::new(
                program,
                Transfer {
                    from: worker,
                    to: entry.clone(),
                },
            ),
            top_up,
        )?;
    }
    allocate(
        CpiContext::new_with_signer(
            program,
            Allocate {
                account_to_allocate: entry.clone(),
            },
            signer,
        ),
        space,
    )?;
    assign(
        CpiContext::new_with_signer(
            program,
            Assign {
                account_to_assign: entry,
            },
            signer,
        ),
        &crate::ID,
    )
}

pub fn handle_stand_by(ctx: Context<StandBy>, secs: u32) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let intent = ctx.accounts.intent.key();
    {
        let held = ctx.accounts.intent.load()?;
        let status = Status::try_from(held.status).map_err(core_err)?;
        require!(
            status == Status::Open && now < held.expires_at,
            EngineError::InvalidTransition
        );
        require!(held.claims == CLAIMS_OPEN, EngineError::ClaimsMissing);
        check_fills_on(&*ctx.accounts.config.load()?, held.kind)?;
    }
    let (seq, stake) = {
        let mut board = ctx.accounts.board.load_mut()?;
        check_listed(
            &board,
            ctx.accounts.claim_list.as_ref(),
            &ctx.accounts.worker.key(),
        )?;
        let terms = Terms::new(board.max_secs, board.stake).map_err(core_err)?;
        require!(
            secs >= 1 && secs <= terms.max_secs(),
            EngineError::ClaimTerms
        );
        let slot = slot_of(&board, now);
        let worker = ctx.accounts.worker.key().to_bytes();
        require!(
            !matches!(slot, Slot::Held { worker: holder, .. } if holder == worker),
            EngineError::HolderStandsBy
        );
        let mut line = line_of(&board);
        line.check_join(slot).map_err(core_err)?;
        let seq = line.join().map_err(core_err)?;
        board.tail = line.tail;
        (seq, terms.stake())
    };
    let (address, bump) = standby_address(&intent, seq);
    require_keys_eq!(
        ctx.accounts.entry.key(),
        address,
        EngineError::LineEntryMismatch
    );
    create_entry(&ctx, seq, bump, stake)?;
    let worker = ctx.accounts.worker.key();
    {
        let entry = ctx.accounts.entry.to_account_info();
        let mut data = entry.try_borrow_mut_data()?;
        let disc = Standby::DISCRIMINATOR;
        data.get_mut(..disc.len())
            .ok_or(EngineError::LineEntryMismatch)?
            .copy_from_slice(disc);
        let body = data
            .get_mut(disc.len()..Standby::SPACE)
            .ok_or(EngineError::LineEntryMismatch)?;
        let stored: &mut Standby =
            bytemuck::try_from_bytes_mut(body).map_err(|_| EngineError::LineEntryMismatch)?;
        stored.worker = worker;
        stored.intent = intent;
        stored.seq = seq;
        stored.secs = secs;
        stored.bump = bump;
        stored.version = STANDBY_VERSION;
    }
    emit_cpi!(StoodBy {
        intent,
        worker,
        seq,
        secs,
        stake,
    });
    Ok(())
}
