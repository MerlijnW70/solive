use anchor_lang::prelude::*;
use intent_core::committee::Committee as CoreCommittee;

use crate::errors::{core_err, EngineError};
use crate::events::CommitteeCreated;
use crate::state::{Committee, COMMITTEE_SEED, COMMITTEE_VERSION};

#[event_cpi]
#[derive(Accounts)]
#[instruction(id: [u8; 32])]
pub struct CreateCommittee<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = Committee::SPACE,
        seeds = [COMMITTEE_SEED, id.as_ref()],
        bump
    )]
    pub committee: AccountLoader<'info, Committee>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_committee(
    ctx: Context<CreateCommittee>,
    id: [u8; 32],
    members: Vec<Pubkey>,
    threshold: u8,
    fee_wallet: Pubkey,
) -> Result<()> {
    let keys: Vec<[u8; 32]> = members.iter().map(Pubkey::to_bytes).collect();
    let core = CoreCommittee::new(&keys, threshold, fee_wallet.to_bytes()).map_err(core_err)?;
    let derived = solana_sha256_hasher::hashv(&[&core.preimage()]).to_bytes();
    require!(derived == id, EngineError::CommitteeInvalid);
    let count = u8::try_from(members.len()).map_err(|_| EngineError::CommitteeInvalid)?;
    {
        let mut committee = ctx.accounts.committee.load_init()?;
        for (slot, member) in committee.members.iter_mut().zip(members.iter()) {
            *slot = *member;
        }
        committee.fee_wallet = fee_wallet;
        committee.id = id;
        committee.created_at = Clock::get()?.unix_timestamp;
        committee.threshold = threshold;
        committee.count = count;
        committee.version = COMMITTEE_VERSION;
        committee.bump = ctx.bumps.committee;
    }
    emit_cpi!(CommitteeCreated {
        committee: ctx.accounts.committee.key(),
        members,
        threshold,
        fee_wallet,
    });
    Ok(())
}
