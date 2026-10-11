use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;
use intent_core::ext::check_flags;
use intent_core::kinds::{Intent as CoreIntent, Kind};
use intent_core::mandate::{in_lane, is_mandated_nonce};
use intent_core::nonce::Window;

use crate::errors::{core_err, EngineError};
use crate::instructions::CreateIntentArgs;
use crate::policy::{can_receive, check_mint};
use crate::state::{Config, Intent, UserState, INTENT_VERSION, PAUSE_CREATE};

pub struct Opening<'a, 'info> {
    pub config: &'a AccountLoader<'info, Config>,
    pub user_state: &'a AccountLoader<'info, UserState>,
    pub intent: &'a AccountLoader<'info, Intent>,
    pub input_mint: &'a InterfaceAccount<'info, Mint>,
    pub output_mint: &'a InterfaceAccount<'info, Mint>,
    pub receiver: &'a AccountInfo<'info>,
    pub receiver_authority: &'a AccountInfo<'info>,
    pub owner: Pubkey,
    pub rent_payer: Pubkey,
    pub intent_bump: u8,
    pub vault_bump: u8,
    pub mandate: Option<(Pubkey, u64, u64)>,
}

pub struct Admission {
    pub decoded: CoreIntent,
    pub bounty: u32,
    pub create_fee: u32,
}

pub fn open_intent(o: &Opening, args: &CreateIntentArgs, now: i64) -> Result<Admission> {
    let kind = Kind::try_from(args.kind).map_err(core_err)?;
    check_flags(args.flags).map_err(core_err)?;
    let partner = intent_core::ext::partner(&args.ext.0).map_err(core_err)?;
    let (bounty, create_fee, partner_cut_bps) = {
        let config = o.config.load()?;
        require!(config.paused & PAUSE_CREATE == 0, EngineError::CreatePaused);
        require!(
            kind.enabled_in(config.enabled_kinds),
            EngineError::KindDisabled
        );
        (
            config.crank_bounty,
            config.create_fee,
            config.partner_cut_bps,
        )
    };
    require!(
        create_fee <= args.max_create_fee && bounty <= args.max_bounty,
        EngineError::CreateCostAboveCeiling
    );
    let decoded = CoreIntent::decode(args.kind, &args.params).map_err(core_err)?;
    require!(args.expires_at > now, EngineError::ExpiryNotInFuture);
    require!(
        decoded.fits_expiry(args.expires_at),
        EngineError::AuctionOutlivesExpiry
    );
    require_keys_neq!(
        *o.receiver_authority.owner,
        crate::ID,
        EngineError::ReceiverNotAllowed
    );
    let input_mint = o.input_mint.key();
    let output_mint = o.output_mint.key();
    require_keys_neq!(input_mint, output_mint, EngineError::SameMint);
    check_mint(&o.input_mint.to_account_info())?;
    check_mint(&o.output_mint.to_account_info())?;
    require!(
        can_receive(
            o.receiver,
            o.output_mint.to_account_info().owner,
            &output_mint,
            o.receiver_authority.key
        ),
        EngineError::ReceiverCannotReceive
    );
    if let Some((_, serial, _)) = o.mandate {
        require!(in_lane(args.nonce, serial), EngineError::MandateMismatch);
    } else {
        require!(
            !is_mandated_nonce(args.nonce),
            EngineError::NonceOutOfWindow
        );
        let mut user = o.user_state.load_mut()?;
        let mut window = Window {
            base: user.nonce_base,
            bits: user.nonce_bitmap,
        };
        window.consume(args.nonce).map_err(core_err)?;
        user.nonce_bitmap = window.bits;
    }
    let mut intent = o.intent.load_init()?;
    intent.owner = o.owner;
    intent.input_mint = input_mint;
    intent.output_mint = output_mint;
    intent.receiver = o.receiver.key();
    intent.nonce = args.nonce;
    intent.escrowed = decoded.escrow_amount();
    intent.created_at = now;
    intent.expires_at = args.expires_at;
    (intent.kind, intent.flags) = (args.kind, args.flags);
    intent.bump = o.intent_bump;
    intent.vault_bump = o.vault_bump;
    intent.version = INTENT_VERSION;
    intent.params = args.params;
    intent.rent_payer = o.rent_payer;
    intent.bounty = bounty;
    if let Some(p) = partner {
        intent.partner = Pubkey::new_from_array(p.key);
        intent.partner_bps = p.bps;
        intent.partner_cut_bps = partner_cut_bps;
    }
    if let Some((mandate, serial, agent_fee)) = o.mandate {
        intent.mandate = mandate;
        intent.mandate_serial = serial;
        intent.agent_fee = agent_fee;
    }
    Ok(Admission {
        decoded,
        bounty,
        create_fee,
    })
}
