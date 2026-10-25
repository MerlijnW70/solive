use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use intent_core::bounty::split_n;
use intent_core::delivery::{split_hash_preimage, AnnState};
use intent_core::kinds::Intent as CoreIntent;

use crate::attested::SplitClaim;
use crate::caps::release_mint_cap;
use crate::errors::{core_err, EngineError};
use crate::events::HeldShareClaimed;
use crate::policy::{pay_from_vault, split_net, FeeTerms, IntentSigner};
use crate::state::{
    Announcement, Intent, MintCap, ANNOUNCEMENT_VERSION, INTENT_VERSION, MINT_CAP_SEED,
    MINT_CAP_VERSION, VAULT_SEED,
};

#[event_cpi]
#[derive(Accounts)]
pub struct ClaimHeld<'info> {
    pub wallet: Signer<'info>,
    #[account(
        mut,
        has_one = input_mint,
        constraint = intent.load()?.version == INTENT_VERSION @ EngineError::AccountOutdated
    )]
    pub intent: AccountLoader<'info, Intent>,
    #[account(
        mut,
        seeds = [VAULT_SEED, intent.key().as_ref()],
        bump = intent.load()?.vault_bump,
        token::mint = input_mint,
        token::authority = intent,
        token::token_program = input_token_program
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mint::token_program = input_token_program)]
    pub input_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        constraint = announcement.load()?.version == ANNOUNCEMENT_VERSION @ EngineError::AccountOutdated,
        constraint = announcement.load()?.intent == intent.key() @ EngineError::AnnouncementMismatch
    )]
    pub announcement: AccountLoader<'info, Announcement>,
    #[account(
        mut,
        token::mint = input_mint,
        token::authority = wallet,
        token::token_program = input_token_program
    )]
    pub to: Box<InterfaceAccount<'info, TokenAccount>>,
    pub input_token_program: Interface<'info, TokenInterface>,
    #[account(
        mut,
        seeds = [MINT_CAP_SEED, input_mint.key().as_ref()],
        bump = mint_cap.load()?.bump,
        constraint = mint_cap.load()?.version == MINT_CAP_VERSION @ EngineError::AccountOutdated
    )]
    pub mint_cap: Option<AccountLoader<'info, MintCap>>,
}

pub fn handle_claim_held(ctx: Context<ClaimHeld>, index: u8, claim: SplitClaim) -> Result<()> {
    let wallet = ctx.accounts.wallet.key();
    let bit = 1u8
        .checked_shl(u32::from(index))
        .ok_or(EngineError::NoShareHeld)?;
    let split_hash = {
        let stored = ctx.accounts.announcement.load()?;
        require!(
            AnnState::try_from(stored.state).map_err(core_err)? == AnnState::Paid,
            EngineError::NoShareHeld
        );
        require!(stored.held & bit != 0, EngineError::NoShareHeld);
        stored.split_hash
    };
    let wallets: Vec<[u8; 32]> = claim.recipients.iter().map(Pubkey::to_bytes).collect();
    let (buf, used) = split_hash_preimage(&wallets, &claim.weights).map_err(core_err)?;
    let hash =
        solana_sha256_hasher::hashv(&[buf.get(..used).ok_or(EngineError::HeldSplitMismatch)?])
            .to_bytes();
    require!(hash == split_hash, EngineError::HeldSplitMismatch);
    require!(
        claim.recipients.get(usize::from(index)) == Some(&wallet),
        EngineError::HeldSplitMismatch
    );
    let (signer, share) = {
        let intent = ctx.accounts.intent.load()?;
        let (amount_in, judge_fee) =
            match CoreIntent::decode(intent.kind, &intent.params).map_err(core_err)? {
                CoreIntent::AttestedResult(p) => (p.amount_in, p.judge_fee),
                CoreIntent::SwapExactIn(_)
                | CoreIntent::LimitOrder(_)
                | CoreIntent::DutchAuction(_) => return Err(EngineError::NoShareHeld.into()),
            };
        let net = split_net(amount_in, judge_fee, FeeTerms::recorded(&intent))?;
        let plan = split_n(net, &claim.weights).map_err(core_err)?;
        let share = *plan
            .as_slice()
            .get(usize::from(index))
            .ok_or(EngineError::HeldSplitMismatch)?;
        (
            IntentSigner {
                owner: intent.owner,
                nonce: intent.nonce.to_le_bytes(),
                bump: [intent.bump],
            },
            share,
        )
    };
    pay_from_vault(
        &ctx.accounts.input_token_program,
        &ctx.accounts.vault,
        &ctx.accounts.input_mint,
        ctx.accounts.to.to_account_info(),
        ctx.accounts.intent.to_account_info(),
        &signer,
        share,
    )?;
    let left = {
        let mut stored = ctx.accounts.announcement.load_mut()?;
        stored.held &= !bit;
        stored.held
    };
    if left == 0 {
        ctx.accounts.intent.load_mut()?.held = 0;
    }
    release_mint_cap(ctx.accounts.mint_cap.as_ref(), &ctx.accounts.intent, share)?;
    emit_cpi!(HeldShareClaimed {
        intent: ctx.accounts.intent.key(),
        announcement: ctx.accounts.announcement.key(),
        wallet,
        to: ctx.accounts.to.key(),
        index,
        share,
        left: u8::try_from(left.count_ones()).map_err(|_| EngineError::Overflow)?,
    });
    Ok(())
}
