use anchor_lang::prelude::*;
use intent_core::profile::{document, encryption_key, skills, url};

use crate::errors::{core_err, EngineError};
use crate::events::{ProfileClosed, ProfileSet};
use crate::state::{Profile, PROFILE_SEED, PROFILE_VERSION};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProfileFields {
    pub skills: Vec<String>,
    pub endpoint: String,
    pub doc_url: String,
    pub doc_hash: [u8; 32],
    pub encryption_key: [u8; 32],
}

#[event_cpi]
#[derive(Accounts)]
pub struct CreateProfile<'info> {
    #[account(mut)]
    pub wallet: Signer<'info>,
    #[account(
        init,
        payer = wallet,
        space = Profile::SPACE,
        seeds = [PROFILE_SEED, wallet.key().as_ref()],
        bump
    )]
    pub profile: AccountLoader<'info, Profile>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct UpdateProfile<'info> {
    pub wallet: Signer<'info>,
    #[account(
        mut,
        seeds = [PROFILE_SEED, wallet.key().as_ref()],
        bump = profile.load()?.bump,
        constraint = profile.load()?.version == PROFILE_VERSION @ EngineError::AccountOutdated
    )]
    pub profile: AccountLoader<'info, Profile>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct CloseProfile<'info> {
    #[account(mut)]
    pub wallet: Signer<'info>,
    #[account(
        mut,
        close = wallet,
        seeds = [PROFILE_SEED, wallet.key().as_ref()],
        bump = profile.load()?.bump,
        constraint = profile.load()?.version == PROFILE_VERSION @ EngineError::AccountOutdated
    )]
    pub profile: AccountLoader<'info, Profile>,
}

fn write(profile: &mut Profile, args: &ProfileFields, now: i64) -> Result<()> {
    let tags: Vec<&[u8]> = args.skills.iter().map(String::as_bytes).collect();
    profile.skills = skills(&tags).map_err(core_err)?;
    profile.endpoint = url(args.endpoint.as_bytes(), false).map_err(core_err)?;
    profile.doc_url = document(args.doc_url.as_bytes(), &args.doc_hash).map_err(core_err)?;
    profile.doc_hash = args.doc_hash;
    profile.encryption_key = encryption_key(&args.encryption_key).map_err(core_err)?;
    profile.updated_at = now;
    Ok(())
}

fn announced(wallet: Pubkey, args: ProfileFields) -> ProfileSet {
    ProfileSet {
        wallet,
        skills: args.skills,
        endpoint: args.endpoint,
        doc_url: args.doc_url,
        doc_hash: args.doc_hash,
        encryption_key: args.encryption_key,
    }
}

pub fn handle_create_profile(ctx: Context<CreateProfile>, args: ProfileFields) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let wallet = ctx.accounts.wallet.key();
    {
        let mut profile = ctx.accounts.profile.load_init()?;
        write(&mut profile, &args, now)?;
        profile.wallet = wallet;
        profile.version = PROFILE_VERSION;
        profile.bump = ctx.bumps.profile;
    }
    emit_cpi!(announced(wallet, args));
    Ok(())
}

pub fn handle_update_profile(ctx: Context<UpdateProfile>, args: ProfileFields) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    {
        let mut profile = ctx.accounts.profile.load_mut()?;
        write(&mut profile, &args, now)?;
    }
    emit_cpi!(announced(ctx.accounts.wallet.key(), args));
    Ok(())
}

pub fn handle_close_profile(ctx: Context<CloseProfile>) -> Result<()> {
    emit_cpi!(ProfileClosed {
        wallet: ctx.accounts.wallet.key(),
    });
    Ok(())
}
