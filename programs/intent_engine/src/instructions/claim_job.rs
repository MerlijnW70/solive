use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use intent_core::claim::{Slot, StakeTo, Terms};
use intent_core::lifecycle::Status;

use crate::claims::{cooldown_of, line_of, move_lamports, slot_of, stake_receiver};
use crate::errors::{core_err, EngineError};
use crate::events::{JobClaimed, StakeMoved};
use crate::policy::check_fills_on;
use crate::roster::check_listed;
use crate::state::{
    ClaimBoard, ClaimList, Config, Intent, CLAIMS_OPEN, CLAIMS_SEED, CLAIMS_VERSION,
    CLAIM_LIST_SEED, CLAIM_LIST_VERSION, CONFIG_ADDRESS, CONFIG_VERSION, INTENT_VERSION,
};

#[event_cpi]
#[derive(Accounts)]
pub struct ClaimJob<'info> {
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
    /// CHECK: the board's recorded owner, paid a lapsed claim's stake
    #[account(mut, address = board.load()?.owner @ EngineError::StakeAccountMismatch)]
    pub owner: UncheckedAccount<'info>,
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

pub fn handle_claim_job(ctx: Context<ClaimJob>, secs: u32) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let expires_at = {
        let intent = ctx.accounts.intent.load()?;
        let status = Status::try_from(intent.status).map_err(core_err)?;
        require!(
            status == Status::Open && now < intent.expires_at,
            EngineError::InvalidTransition
        );
        require!(intent.claims == CLAIMS_OPEN, EngineError::ClaimsMissing);
        check_fills_on(&*ctx.accounts.config.load()?, intent.kind)?;
        intent.expires_at
    };
    let (slot, cooldown, terms, held, lapsed) = {
        let board = ctx.accounts.board.load()?;
        check_listed(
            &board,
            ctx.accounts.claim_list.as_ref(),
            &ctx.accounts.worker.key(),
        )?;
        let slot = slot_of(&board, now);
        let cooldown = cooldown_of(&board);
        line_of(&board).check_claim().map_err(core_err)?;
        let terms = Terms::new(board.max_secs, board.stake).map_err(core_err)?;
        let lapsed = match slot {
            Slot::Lapsed { .. } => Some(stake_receiver(&board, StakeTo::Owner)),
            Slot::Free | Slot::Held { .. } => None,
        };
        (slot, cooldown, terms, board.held, lapsed)
    };
    cooldown
        .check(slot, ctx.accounts.worker.key().to_bytes(), now)
        .map_err(core_err)?;
    let until = terms.until(now, secs, expires_at).map_err(core_err)?;
    let intent = ctx.accounts.intent.key();
    if terms.stake() > 0 {
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.worker.to_account_info(),
                    to: ctx.accounts.board.to_account_info(),
                },
            ),
            terms.stake(),
        )?;
    }
    if let (Slot::Lapsed { worker }, Some((owner, role))) = (slot, lapsed) {
        move_lamports(
            &ctx.accounts.board.to_account_info(),
            &ctx.accounts.owner.to_account_info(),
            held,
        )?;
        emit_cpi!(StakeMoved {
            intent,
            worker: Pubkey::new_from_array(worker),
            to: owner,
            amount: held,
            role,
        });
    }
    let worker = ctx.accounts.worker.key();
    {
        let mut board = ctx.accounts.board.load_mut()?;
        board.worker = worker;
        board.until = until;
        board.held = terms.stake();
        board.dropped_by = Pubkey::default();
    }
    emit_cpi!(JobClaimed {
        intent,
        worker,
        until,
        stake: terms.stake(),
    });
    Ok(())
}
