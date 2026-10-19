use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use anchor_spl::token_2022::spl_token_2022::extension::{
    BaseStateWithExtensions, ExtensionType, StateWithExtensions,
};
use anchor_spl::token_2022::spl_token_2022::state::{
    Account as TokenState, AccountState, Mint as MintState,
};
use anchor_spl::token_interface::{
    close_account, transfer_checked, CloseAccount, Mint, TokenAccount, TokenInterface,
    TransferChecked,
};
use intent_core::bounty::split_n;
use intent_core::fee::{split_fees, Fees};
use intent_core::kinds::{Kind, ALL_KINDS_MASK};
use intent_core::mint_policy::mint_extensions_allowed;
use intent_core::sig::{check_ed25519_cosign, check_ed25519_ix, Cosigners};
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

use crate::errors::{core_err, EngineError};
use crate::state::{
    delegate_address, Config, Intent, Mandate, UserState, BPS, DELEGATE_SEED, INTENT_SEED,
    MANDATE_VERSION, MAX_ATTESTED_FEE_BPS, MAX_CRANK_BOUNTY, MAX_CREATE_FEE, MAX_FEE_BPS,
    PAUSE_ALL, USER_VERSION,
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct ConfigSettings {
    pub guardian: Pubkey,
    pub fee_recipient: Pubkey,
    pub enabled_kinds: u64,
    pub fee_bps: u16,
    pub paused: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct ConfigUpdate {
    pub guardian: Pubkey,
    pub fee_recipient: Pubkey,
    pub enabled_kinds: u64,
    pub fee_bps: u16,
    pub fill_disabled_kinds: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct Economics {
    pub kind_fee_mask: u8,
    pub kind_fee_bps: [u16; 4],
    pub partner_cut_bps: u16,
    pub crank_bounty: u32,
    pub create_fee: u32,
}

pub fn validate_economics(e: &Economics) -> Result<()> {
    check_kind_bits(u64::from(e.kind_fee_mask))?;
    let [swap, limit, dutch, attested] = e.kind_fee_bps;
    require!(
        [swap, limit, dutch].iter().all(|bps| *bps <= MAX_FEE_BPS)
            && attested <= MAX_ATTESTED_FEE_BPS,
        EngineError::FeeTooHigh
    );
    require!(e.partner_cut_bps <= BPS, EngineError::PartnerCutTooHigh);
    require!(
        e.crank_bounty <= MAX_CRANK_BOUNTY,
        EngineError::CrankBountyTooHigh
    );
    require!(
        e.create_fee <= MAX_CREATE_FEE,
        EngineError::CreateFeeTooHigh
    );
    Ok(())
}

pub fn move_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    from.sub_lamports(amount)?;
    to.add_lamports(amount)?;
    Ok(())
}

pub fn charge_lamports<'info>(
    system_program: &Program<'info, System>,
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                system_program.key(),
                anchor_lang::system_program::Transfer { from, to },
            ),
            amount,
        )?;
    }
    Ok(())
}

pub fn charge_treasury<'info>(
    system_program: &Program<'info, System>,
    from: AccountInfo<'info>,
    treasury: AccountInfo<'info>,
    fee: u32,
) -> Result<u32> {
    let after = treasury
        .lamports()
        .checked_add(u64::from(fee))
        .ok_or(EngineError::Overflow)?;
    if treasury.executable || !Rent::get()?.is_exempt(after, treasury.data_len()) {
        return Ok(0);
    }
    charge_lamports(system_program, from, treasury, u64::from(fee))?;
    Ok(fee)
}

pub fn check_fill_kind(kind: u8, disabled: u64) -> Result<()> {
    let kind = Kind::try_from(kind).map_err(core_err)?;
    require!(!kind.enabled_in(disabled), EngineError::FillKindDisabled);
    Ok(())
}

pub fn check_mandate_live(
    intent: &Intent,
    mandate: Option<&AccountInfo>,
    owner_state: Option<&AccountLoader<UserState>>,
) -> Result<()> {
    if intent.mandate == Pubkey::default() {
        return Ok(());
    }
    let (mandate, owner_state) = mandate
        .zip(owner_state)
        .ok_or(EngineError::MandateRevoked)?;
    require_keys_eq!(mandate.key(), intent.mandate, EngineError::MandateMismatch);
    require_keys_eq!(*mandate.owner, crate::ID, EngineError::MandateRevoked);
    let data = mandate.try_borrow_data()?;
    let body = data
        .strip_prefix(Mandate::DISCRIMINATOR)
        .ok_or(EngineError::MandateRevoked)?;
    let grant: &Mandate =
        bytemuck::try_from_bytes(body).map_err(|_| EngineError::MandateRevoked)?;
    require!(
        grant.version == MANDATE_VERSION,
        EngineError::UnsupportedVersion
    );
    let user = owner_state.load()?;
    require!(
        user.version == USER_VERSION,
        EngineError::UnsupportedVersion
    );
    require!(
        grant.serial == intent.mandate_serial && grant.epoch == user.epoch,
        EngineError::MandateRevoked
    );
    Ok(())
}

pub struct Draw<'a, 'info> {
    pub token_program: &'a Interface<'info, TokenInterface>,
    pub from: AccountInfo<'info>,
    pub mint: &'a InterfaceAccount<'info, Mint>,
    pub delegate: AccountInfo<'info>,
    pub owner: Pubkey,
    pub bump: u8,
}

impl<'info> Draw<'_, 'info> {
    pub fn to(&self, to: AccountInfo<'info>, amount: u64) -> Result<()> {
        let bump = [self.bump];
        let seeds: [&[u8]; 3] = [DELEGATE_SEED, self.owner.as_ref(), &bump];
        transfer_checked(
            CpiContext::new_with_signer(
                self.token_program.key(),
                TransferChecked {
                    from: self.from.clone(),
                    mint: self.mint.to_account_info(),
                    to,
                    authority: self.delegate.clone(),
                },
                &[&seeds],
            ),
            amount,
            self.mint.decimals,
        )
    }

    pub fn fee(
        &self,
        to: Option<&InterfaceAccount<'info, TokenAccount>>,
        amount: u64,
    ) -> Result<Option<Pubkey>> {
        if amount == 0 {
            return Ok(None);
        }
        let to = to.ok_or(EngineError::FeeAccountMissing)?;
        self.to(to.to_account_info(), amount)?;
        Ok(Some(to.key()))
    }
}

pub struct Tally {
    pub amount_in: u64,
    pub filled: u64,
    pub remaining: u64,
}

pub fn take_remaining(intent: &mut Intent, amount_in: u64) -> Result<Tally> {
    let remaining = intent
        .escrowed
        .checked_sub(intent.filled)
        .ok_or(EngineError::Overflow)?;
    require!(amount_in == remaining, EngineError::AmountInMismatch);
    intent.filled = intent.escrowed;
    intent.revision = intent
        .revision
        .checked_add(1)
        .ok_or(EngineError::Overflow)?;
    Ok(Tally {
        amount_in,
        filled: intent.filled,
        remaining: intent.escrowed.saturating_sub(intent.filled),
    })
}

pub fn check_kind_bits(mask: u64) -> Result<()> {
    require!(mask & !ALL_KINDS_MASK == 0, EngineError::UnknownKindBits);
    Ok(())
}

pub fn validate_terms(enabled_kinds: u64, fee_bps: u16) -> Result<()> {
    require!(fee_bps <= MAX_FEE_BPS, EngineError::FeeTooHigh);
    check_kind_bits(enabled_kinds)
}

pub fn validate_config(args: &ConfigSettings) -> Result<()> {
    validate_terms(args.enabled_kinds, args.fee_bps)?;
    require!(
        args.paused & !PAUSE_ALL == 0,
        EngineError::InvalidPauseFlags
    );
    Ok(())
}

pub fn check_mint(mint: &AccountInfo) -> Result<()> {
    if *mint.owner == anchor_spl::token::ID {
        return Ok(());
    }
    require_keys_eq!(
        *mint.owner,
        anchor_spl::token_2022::ID,
        EngineError::MintNotAllowed
    );
    let data = mint.try_borrow_data()?;
    let state =
        StateWithExtensions::<MintState>::unpack(&data).map_err(|_| EngineError::MintNotAllowed)?;
    let types = state
        .get_extension_types()
        .map_err(|_| EngineError::MintNotAllowed)?;
    require!(
        mint_extensions_allowed(types.into_iter().map(u16::from)),
        EngineError::MintNotAllowed
    );
    Ok(())
}

pub struct IntentSigner {
    pub owner: Pubkey,
    pub nonce: [u8; 8],
    pub bump: [u8; 1],
}

impl IntentSigner {
    pub fn seeds(&self) -> [&[u8]; 4] {
        [INTENT_SEED, self.owner.as_ref(), &self.nonce, &self.bump]
    }
}

pub fn release_vault<'info>(
    token_program: &Interface<'info, TokenInterface>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    to: AccountInfo<'info>,
    intent: AccountInfo<'info>,
    signer: &IntentSigner,
) -> Result<u64> {
    let amount = vault.amount;
    pay_from_vault(token_program, vault, mint, to, intent, signer, amount)?;
    Ok(amount)
}

pub fn pay_from_vault<'info>(
    token_program: &Interface<'info, TokenInterface>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    to: AccountInfo<'info>,
    intent: AccountInfo<'info>,
    signer: &IntentSigner,
    amount: u64,
) -> Result<()> {
    if amount > 0 {
        let seeds = signer.seeds();
        let signer_seeds: &[&[&[u8]]] = &[&seeds];
        transfer_checked(
            CpiContext::new_with_signer(
                token_program.key(),
                TransferChecked {
                    from: vault.to_account_info(),
                    mint: mint.to_account_info(),
                    to,
                    authority: intent,
                },
                signer_seeds,
            ),
            amount,
            mint.decimals,
        )?;
    }
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct AgentPayout {
    pub account: Pubkey,
    pub paid: bool,
}

pub fn pay_agent<'info>(
    token_program: &Interface<'info, TokenInterface>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    to: Option<&InterfaceAccount<'info, TokenAccount>>,
    intent: AccountInfo<'info>,
    signer: &IntentSigner,
    (agent, fee): (Pubkey, u64),
) -> Result<Option<AgentPayout>> {
    if fee == 0 {
        return Ok(None);
    }
    let to = to.ok_or(EngineError::FeeAccountMissing)?;
    if !receives(to, token_program, mint, &agent) {
        return Ok(Some(AgentPayout {
            account: to.key(),
            paid: false,
        }));
    }
    pay_from_vault(
        token_program,
        vault,
        mint,
        to.to_account_info(),
        intent,
        signer,
        fee,
    )?;
    Ok(Some(AgentPayout {
        account: to.key(),
        paid: true,
    }))
}

pub fn owner_controlled(account: &AccountInfo, owner: &Pubkey) -> bool {
    account.try_borrow_data().is_ok_and(|data| {
        StateWithExtensions::<TokenState>::unpack(&data).is_ok_and(|state| {
            Option::<Pubkey>::from(state.base.delegate)
                .is_none_or(|delegate| delegate == delegate_address(owner))
                && Option::<Pubkey>::from(state.base.close_authority)
                    .is_none_or(|authority| authority == *owner)
        })
    })
}

pub fn check_refund_target(
    refund_to: &AccountInfo,
    canonical: &AccountInfo,
    token_program: &Pubkey,
    mint: &Pubkey,
    owner: &Pubkey,
) -> Result<()> {
    if refund_to.key == canonical.key {
        require!(
            refundable(canonical, token_program, mint, owner),
            EngineError::RefundCannotReceive
        );
    } else {
        require!(
            canonical.owner == token_program && !refundable(canonical, token_program, mint, owner),
            EngineError::RefundNotCanonical
        );
        require!(
            refundable(refund_to, token_program, mint, owner),
            EngineError::RefundCannotReceive
        );
    }
    Ok(())
}

pub fn refundable(
    account: &AccountInfo,
    token_program: &Pubkey,
    mint: &Pubkey,
    owner: &Pubkey,
) -> bool {
    can_receive(account, token_program, mint, owner) && owner_controlled(account, owner)
}

pub fn can_receive(
    account: &AccountInfo,
    token_program: &Pubkey,
    mint: &Pubkey,
    owner: &Pubkey,
) -> bool {
    account.owner == token_program
        && account.try_borrow_data().is_ok_and(|data| {
            StateWithExtensions::<TokenState>::unpack(&data).is_ok_and(|state| {
                state.base.mint == *mint
                    && state.base.owner == *owner
                    && state.base.state == AccountState::Initialized
                    && state.get_extension_types().is_ok_and(|types| {
                        types.iter().all(|t| *t == ExtensionType::ImmutableOwner)
                    })
            })
        })
}

pub fn close_vault<'info>(
    token_program: &Interface<'info, TokenInterface>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    destination: AccountInfo<'info>,
    intent: AccountInfo<'info>,
    signer: &IntentSigner,
) -> Result<()> {
    let seeds = signer.seeds();
    let signer_seeds: &[&[&[u8]]] = &[&seeds];
    close_account(CpiContext::new_with_signer(
        token_program.key(),
        CloseAccount {
            account: vault.to_account_info(),
            destination,
            authority: intent,
        },
        signer_seeds,
    ))
}

pub fn verify_ed25519_at(
    instructions: &AccountInfo,
    index: usize,
    signer: &Pubkey,
    message: &[u8],
) -> Result<()> {
    let ix = load_instruction_at_checked(index, instructions)?;
    check_ed25519_ix(
        &ix.program_id.to_bytes(),
        &ix.data,
        &signer.to_bytes(),
        message,
    )
    .map_err(core_err)?;
    Ok(())
}

pub fn verify_preceding_ed25519(
    instructions: &AccountInfo,
    signer: &Pubkey,
    message: &[u8],
) -> Result<()> {
    let current = load_current_index_checked(instructions)?;
    let previous = current.checked_sub(1).ok_or(EngineError::SigMissing)?;
    verify_ed25519_at(instructions, usize::from(previous), signer, message)
}

fn cosigner_set(keys: &[Pubkey]) -> Result<Box<Cosigners>> {
    let bytes: Vec<[u8; 32]> = keys.iter().map(Pubkey::to_bytes).collect();
    Ok(Box::new(Cosigners::new(&bytes).map_err(core_err)?))
}

pub fn verify_preceding_cosign(
    instructions: &AccountInfo,
    listed: &[Pubkey],
    signers: &[Pubkey],
    digest: &[u8; 32],
) -> Result<()> {
    let current = usize::from(load_current_index_checked(instructions)?);
    let index = current.checked_sub(1).ok_or(EngineError::SigMissing)?;
    let ix = load_instruction_at_checked(index, instructions)?;
    let listed = cosigner_set(listed)?;
    let signers = cosigner_set(signers)?;
    check_ed25519_cosign(
        &ix.program_id.to_bytes(),
        &ix.data,
        &listed,
        &signers,
        digest,
    )
    .map_err(core_err)?;
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct FeeTerms {
    pub fee_bps: u16,
    pub partner_bps: u16,
    pub cut_bps: u16,
    pub partner: Pubkey,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct FeeSchedule {
    pub default_bps: u16,
    pub kind_mask: u8,
    pub kind_bps: [u16; 4],
}

impl FeeSchedule {
    pub fn of(config: &Config) -> Self {
        Self {
            default_bps: config.fee_bps,
            kind_mask: config.kind_fee_mask,
            kind_bps: config.kind_fee_bps,
        }
    }

    pub fn fee_bps(&self, kind: u8) -> Result<u16> {
        let kind = Kind::try_from(kind).map_err(core_err)?;
        let [swap, limit, dutch, attested] = self.kind_bps;
        Ok(if kind.enabled_in(u64::from(self.kind_mask)) {
            match kind {
                Kind::SwapExactIn => swap,
                Kind::LimitOrder => limit,
                Kind::DutchAuction => dutch,
                Kind::AttestedResult => attested,
            }
        } else {
            self.default_bps
        })
    }
}

impl FeeTerms {
    pub fn recorded(intent: &Intent) -> Self {
        Self {
            fee_bps: intent.fee_bps,
            partner_bps: intent.partner_bps,
            cut_bps: intent.partner_cut_bps,
            partner: intent.partner,
        }
    }
}

pub struct Payout<'a, 'info> {
    pub token_program: &'a Interface<'info, TokenInterface>,
    pub vault: &'a InterfaceAccount<'info, TokenAccount>,
    pub mint: &'a InterfaceAccount<'info, Mint>,
    pub fee_to: Option<&'a InterfaceAccount<'info, TokenAccount>>,
    pub partner_to: Option<&'a InterfaceAccount<'info, TokenAccount>>,
    pub payee: AccountInfo<'info>,
    pub intent: AccountInfo<'info>,
    pub signer: &'a IntentSigner,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Settled {
    pub fees: Fees,
    pub withheld: Option<(Pubkey, u64)>,
}

struct FeeLegs<'a, 'info> {
    token_program: &'a Interface<'info, TokenInterface>,
    vault: &'a InterfaceAccount<'info, TokenAccount>,
    mint: &'a InterfaceAccount<'info, Mint>,
    fee_to: Option<&'a InterfaceAccount<'info, TokenAccount>>,
    partner_to: Option<&'a InterfaceAccount<'info, TokenAccount>>,
    intent: AccountInfo<'info>,
    signer: &'a IntentSigner,
}

fn settle_fees(p: &FeeLegs, amount: u64, terms: FeeTerms, max_fee_bps: u16) -> Result<Settled> {
    require!(
        u32::from(terms.fee_bps).saturating_add(u32::from(terms.partner_bps))
            <= u32::from(max_fee_bps),
        EngineError::FeeAboveBound
    );
    let fees =
        split_fees(amount, terms.fee_bps, terms.partner_bps, terms.cut_bps).map_err(core_err)?;
    if fees.protocol > 0 {
        let fee_to = p.fee_to.ok_or(EngineError::FeeAccountMissing)?;
        pay_from_vault(
            p.token_program,
            p.vault,
            p.mint,
            fee_to.to_account_info(),
            p.intent.clone(),
            p.signer,
            fees.protocol,
        )?;
    }
    let (partner, withheld) = if fees.partner > 0 {
        let partner_to = p.partner_to.ok_or(EngineError::PartnerAccountMissing)?;
        if receives(partner_to, p.token_program, p.mint, &terms.partner) {
            pay_from_vault(
                p.token_program,
                p.vault,
                p.mint,
                partner_to.to_account_info(),
                p.intent.clone(),
                p.signer,
                fees.partner,
            )?;
            (fees.partner, None)
        } else {
            (0, Some((partner_to.key(), fees.partner)))
        }
    } else {
        (0, None)
    };
    Ok(Settled {
        fees: Fees { partner, ..fees },
        withheld,
    })
}

pub fn pay_out(p: Payout, amount: u64, terms: FeeTerms, max_fee_bps: u16) -> Result<Settled> {
    let legs = FeeLegs {
        token_program: p.token_program,
        vault: p.vault,
        mint: p.mint,
        fee_to: p.fee_to,
        partner_to: p.partner_to,
        intent: p.intent.clone(),
        signer: p.signer,
    };
    let settled = settle_fees(&legs, amount, terms, max_fee_bps)?;
    pay_from_vault(
        p.token_program,
        p.vault,
        p.mint,
        p.payee,
        p.intent,
        p.signer,
        settled.fees.net,
    )?;
    Ok(settled)
}

pub struct SplitPayout<'a, 'info> {
    pub token_program: &'a Interface<'info, TokenInterface>,
    pub vault: &'a InterfaceAccount<'info, TokenAccount>,
    pub mint: &'a InterfaceAccount<'info, Mint>,
    pub fee_to: Option<&'a InterfaceAccount<'info, TokenAccount>>,
    pub partner_to: Option<&'a InterfaceAccount<'info, TokenAccount>>,
    pub recipients: &'a [AccountInfo<'info>],
    pub intent: AccountInfo<'info>,
    pub signer: &'a IntentSigner,
}

pub fn pay_out_split(
    p: SplitPayout,
    amount: u64,
    terms: FeeTerms,
    max_fee_bps: u16,
    weights: &[u16],
) -> Result<Settled> {
    let legs = FeeLegs {
        token_program: p.token_program,
        vault: p.vault,
        mint: p.mint,
        fee_to: p.fee_to,
        partner_to: p.partner_to,
        intent: p.intent.clone(),
        signer: p.signer,
    };
    let settled = settle_fees(&legs, amount, terms, max_fee_bps)?;
    let plan = split_n(settled.fees.net, weights).map_err(core_err)?;
    let shares = plan.as_slice();
    require!(
        shares.len() == p.recipients.len(),
        EngineError::SplitCountMismatch
    );
    for (to, share) in p.recipients.iter().zip(shares) {
        pay_from_vault(
            p.token_program,
            p.vault,
            p.mint,
            to.clone(),
            p.intent.clone(),
            p.signer,
            *share,
        )?;
    }
    Ok(settled)
}

pub fn receives(
    to: &InterfaceAccount<'_, TokenAccount>,
    token_program: &Interface<'_, TokenInterface>,
    mint: &InterfaceAccount<'_, Mint>,
    owner: &Pubkey,
) -> bool {
    can_receive(
        &to.to_account_info(),
        &token_program.key(),
        &mint.key(),
        owner,
    )
}

pub fn deliver<'info>(
    token_program: &Interface<'info, TokenInterface>,
    solver_output: AccountInfo<'info>,
    mint: &InterfaceAccount<'info, Mint>,
    receiver: &mut InterfaceAccount<'info, TokenAccount>,
    solver: AccountInfo<'info>,
    amount_out: u64,
) -> Result<(u64, u64)> {
    let before = receiver.amount;
    transfer_checked(
        CpiContext::new(
            token_program.key(),
            TransferChecked {
                from: solver_output,
                mint: mint.to_account_info(),
                to: receiver.to_account_info(),
                authority: solver,
            },
        ),
        amount_out,
        mint.decimals,
    )?;
    receiver.reload()?;
    Ok((before, receiver.amount))
}
