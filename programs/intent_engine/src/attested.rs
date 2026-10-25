use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use intent_core::committee::{Committee as CoreCommittee, COMMITTEE_COSIGN_TAG};
use intent_core::delivery::{commitment_preimage, split_hash_preimage, AnnState, SALT_LEN};
use intent_core::ext::FILL_EXT_TAGS;
use intent_core::fee::Fees;
use intent_core::kinds::Intent as CoreIntent;
use intent_core::lifecycle::{transition, Action, Status};
use intent_core::sig::{
    offchain_envelope, AttestedDelivery, AttestedFill, AttestedSplitDelivery, SPLIT_COSIGN_TAG,
};

use crate::caps::{release_mint_cap, settle_mint_cap};
use crate::claims::honor_on_release;
use crate::errors::{core_err, EngineError};
use crate::events::StakeMoved;
use crate::ext::Ext;
use crate::policy::{
    check_fill_kind, check_mint, pay_agent, pay_out, pay_out_split, take_remaining,
    verify_preceding_cosign, verify_preceding_ed25519, AgentPayout, FeeTerms, HeldShare,
    IntentSigner, Payout, Settled, SplitPayout, Tally,
};
use crate::state::{
    Announcement, ClaimBoard, Committee, Config, Intent, MintCap, ANNOUNCEMENT_VERSION,
    CLAIMS_OPEN, COMMITTEE_VERSION, PAUSE_FILL,
};

pub use intent_core::delivery::MAX_SPLIT_RECIPIENTS;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SplitClaim {
    pub recipients: Vec<Pubkey>,
    pub weights: Vec<u16>,
}

pub enum Judge {
    Key,
    Committee {
        address: Pubkey,
        committee: Box<CoreCommittee>,
        mask: u8,
    },
}

impl Judge {
    pub fn committee(account: &AccountLoader<Committee>, mask: u8) -> Result<Self> {
        let stored = account.load()?;
        require!(
            stored.version == COMMITTEE_VERSION,
            EngineError::AccountOutdated
        );
        let members = stored.members.map(|member| member.to_bytes());
        let committee = CoreCommittee::from_stored(
            stored.threshold,
            stored.count,
            &members,
            stored.fee_wallet.to_bytes(),
        )
        .map_err(core_err)?;
        Ok(Self::Committee {
            address: account.key(),
            committee: Box::new(committee),
            mask,
        })
    }

    fn signers(&self, attestor: &Pubkey) -> Result<Vec<Pubkey>> {
        match self {
            Self::Key => Ok(vec![*attestor]),
            Self::Committee {
                address,
                committee,
                mask,
            } => {
                require_keys_eq!(*address, *attestor, EngineError::CommitteeMismatch);
                let signers = committee.signers(*mask).map_err(core_err)?;
                Ok(signers
                    .keys()
                    .iter()
                    .map(|key| Pubkey::new_from_array(*key))
                    .collect())
            }
        }
    }

    fn eligible(&self, attestor: &Pubkey) -> Vec<Pubkey> {
        match self {
            Self::Key => vec![*attestor],
            Self::Committee { committee, .. } => committee
                .members()
                .iter()
                .map(|key| Pubkey::new_from_array(*key))
                .collect(),
        }
    }

    fn fee_owner(&self, attestor: Pubkey) -> Pubkey {
        match self {
            Self::Key => attestor,
            Self::Committee { committee, .. } => Pubkey::new_from_array(committee.fee_wallet()),
        }
    }
}

pub struct Release<'a, 'info> {
    pub config: &'a AccountLoader<'info, Config>,
    pub intent: &'a AccountLoader<'info, Intent>,
    pub vault: &'a mut Box<InterfaceAccount<'info, TokenAccount>>,
    pub input_mint: &'a InterfaceAccount<'info, Mint>,
    pub fee_to: Option<&'a InterfaceAccount<'info, TokenAccount>>,
    pub partner_to: Option<&'a InterfaceAccount<'info, TokenAccount>>,
    pub judge_to: Option<&'a InterfaceAccount<'info, TokenAccount>>,
    pub input_token_program: &'a Interface<'info, TokenInterface>,
    pub instructions: AccountInfo<'info>,
    pub claims: Option<&'a AccountLoader<'info, ClaimBoard>>,
    pub stake_to: Option<AccountInfo<'info>>,
    pub mint_cap: Option<&'a AccountLoader<'info, MintCap>>,
    pub announcement: Option<&'a AccountLoader<'info, Announcement>>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct Opening {
    pub delivered: [u8; 32],
    pub salt: [u8; SALT_LEN],
}

#[derive(Clone, Copy)]
pub struct Delivered {
    pub announcement: Pubkey,
    pub seq: u64,
    pub worker: Pubkey,
    pub opening: Opening,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct Fill {
    pub amount_in: u64,
    pub result: u64,
    pub max_fee_bps: u16,
}

pub struct Withheld {
    pub payee: Pubkey,
    pub account: Pubkey,
    pub fee: u64,
    pub role: u8,
}

pub struct Released {
    pub owner: Pubkey,
    pub attestor: Pubkey,
    pub signers: Vec<Pubkey>,
    pub tally: Tally,
    pub fees: Fees,
    pub withheld: Vec<Withheld>,
    pub stake: Option<StakeMoved>,
    pub delivered: Option<Delivered>,
}

struct Opened {
    attestor: Pubkey,
    tally: Tally,
    prior: (u64, u32),
    signer: IntentSigner,
    terms: FeeTerms,
    spec_hash: [u8; 32],
    judge_fee: u64,
    domain: [u8; 32],
    claims: u8,
    now: i64,
}

fn open(release: &Release, amount_in: u64, result: u64) -> Result<Opened> {
    let now = Clock::get()?.unix_timestamp;
    let (domain, disabled) = {
        let config = release.config.load()?;
        require!(config.paused & PAUSE_FILL == 0, EngineError::FillPaused);
        (config.domain, config.fill_disabled_kinds)
    };
    check_mint(&release.input_mint.to_account_info())?;
    let mut intent = release.intent.load_mut()?;
    check_fill_kind(intent.kind, disabled)?;
    require!(intent.agent_fee == 0, EngineError::MandateMismatch);
    let terms = FeeTerms::recorded(&intent);
    let status = Status::try_from(intent.status).map_err(core_err)?;
    let next = transition(status, Action::Fill, now, intent.expires_at)
        .map_err(core_err)?
        .ok_or(EngineError::InvalidTransition)?;
    intent.status = next as u8;
    let prior = (intent.filled, intent.revision);
    let tally = take_remaining(&mut intent, amount_in)?;
    let decoded = CoreIntent::decode(intent.kind, &intent.params).map_err(core_err)?;
    let attestor = decoded
        .check_attested(tally.amount_in, result)
        .map_err(core_err)?;
    Ok(Opened {
        attestor: Pubkey::new_from_array(attestor),
        tally,
        prior,
        signer: IntentSigner {
            owner: intent.owner,
            nonce: intent.nonce.to_le_bytes(),
            bump: [intent.bump],
        },
        terms,
        spec_hash: decoded.spec_hash(),
        judge_fee: decoded.judge_fee(),
        domain,
        claims: intent.claims,
        now,
    })
}

fn payee_wallet(payee: &AccountInfo, release: &Release, claims: u8) -> Result<Vec<Pubkey>> {
    if claims != CLAIMS_OPEN {
        return Ok(Vec::new());
    }
    require_keys_eq!(
        *payee.owner,
        release.input_token_program.key(),
        EngineError::ClaimHeld
    );
    let data = payee.try_borrow_data()?;
    let owner: [u8; 32] = data
        .get(32..64)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(EngineError::ClaimHeld)?;
    Ok(vec![Pubkey::new_from_array(owner)])
}

fn announced(release: &Release, opening: &Opening) -> Result<Delivered> {
    let loader = release
        .announcement
        .ok_or(EngineError::AnnouncementMissing)?;
    let stored = loader.load()?;
    require!(
        stored.version == ANNOUNCEMENT_VERSION,
        EngineError::AccountOutdated
    );
    require_keys_eq!(
        stored.intent,
        release.intent.key(),
        EngineError::AnnouncementMismatch
    );
    require!(
        AnnState::try_from(stored.state).map_err(core_err)? == AnnState::Announced,
        EngineError::AnnouncementPaid
    );
    let preimage = commitment_preimage(
        &stored.intent.to_bytes(),
        &stored.worker.to_bytes(),
        &opening.salt,
        &opening.delivered,
    );
    require!(
        solana_sha256_hasher::hashv(&[&preimage]).to_bytes() == stored.commitment,
        EngineError::CommitmentMismatch
    );
    Ok(Delivered {
        announcement: loader.key(),
        seq: stored.seq,
        worker: stored.worker,
        opening: *opening,
    })
}

fn check_unannounced(release: &Release, opening: &Opening) -> Result<()> {
    require!(
        release.announcement.is_none()
            && opening.delivered == [0u8; 32]
            && opening.salt == [0u8; SALT_LEN],
        EngineError::AnnouncementUnexpected
    );
    Ok(())
}

fn check_payee_owner(payee: &AccountInfo, release: &Release, worker: &Pubkey) -> Result<()> {
    require_keys_eq!(
        *payee.owner,
        release.input_token_program.key(),
        EngineError::PayeeNotAnnouncer
    );
    let data = payee.try_borrow_data()?;
    require!(
        data.get(..32) == Some(release.input_mint.key().as_ref())
            && data.get(32..64) == Some(worker.as_ref()),
        EngineError::PayeeNotAnnouncer
    );
    Ok(())
}

fn mark_paid(release: &Release, opening: &Opening, now: i64, split_hash: [u8; 32]) -> Result<()> {
    let loader = release
        .announcement
        .ok_or(EngineError::AnnouncementMissing)?;
    let mut stored = loader.load_mut()?;
    stored.state = u8::from(AnnState::Paid);
    stored.paid_at = now;
    stored.delivered = opening.delivered;
    stored.salt = opening.salt;
    stored.split_hash = split_hash;
    Ok(())
}

fn pay_judge(
    release: &Release,
    opened: &Opened,
    fee_owner: Pubkey,
    withheld: &mut Vec<Withheld>,
) -> Result<u64> {
    if opened.judge_fee == 0 {
        return Ok(0);
    }
    let judge_to = release.judge_to.ok_or(EngineError::FeeAccountMissing)?;
    let canonical = get_associated_token_address_with_program_id(
        &fee_owner,
        &release.input_mint.key(),
        &release.input_token_program.key(),
    );
    require!(
        judge_to.key() == canonical,
        EngineError::FeeAccountNotCanonical
    );
    match pay_agent(
        release.input_token_program,
        release.vault,
        release.input_mint,
        Some(judge_to),
        release.intent.to_account_info(),
        &opened.signer,
        (fee_owner, opened.judge_fee),
    )? {
        Some(AgentPayout {
            account,
            paid: false,
        }) => {
            withheld.push(Withheld {
                payee: fee_owner,
                account,
                fee: opened.judge_fee,
                role: crate::events::WITHHELD_JUDGE,
            });
            Ok(0)
        }
        Some(AgentPayout { paid: true, .. }) => Ok(opened.judge_fee),
        None => Ok(0),
    }
}

pub fn release_single<'info>(
    release: Release<'_, 'info>,
    payee: AccountInfo<'info>,
    judge: &Judge,
    fill: Fill,
    opening: &Opening,
    ext: &Ext,
) -> Result<Released> {
    let Fill {
        amount_in,
        result,
        max_fee_bps,
    } = fill;
    ext.check(FILL_EXT_TAGS)?;
    let before = release.vault.amount;
    let opened = open(&release, amount_in, result)?;
    let ext_hash = solana_sha256_hasher::hashv(&[&ext.0]).to_bytes();
    let fill_preimage;
    let delivery_preimage;
    let delivered = if opened.spec_hash == [0u8; 32] {
        check_unannounced(&release, opening)?;
        None
    } else {
        let delivered = announced(&release, opening)?;
        check_payee_owner(&payee, &release, &delivered.worker)?;
        Some(delivered)
    };
    let preimage: &[u8] = if let Some(delivered) = delivered {
        delivery_preimage = AttestedDelivery {
            program: crate::ID.to_bytes(),
            domain: opened.domain,
            intent: release.intent.key().to_bytes(),
            payee: payee.key().to_bytes(),
            amount_in: opened.tally.amount_in,
            result,
            filled: opened.prior.0,
            revision: opened.prior.1,
            max_fee_bps,
            ext_hash,
            spec_hash: opened.spec_hash,
            announcement: delivered.announcement.to_bytes(),
            seq: delivered.seq,
            delivered: opening.delivered,
            salt: opening.salt,
        }
        .preimage();
        &delivery_preimage
    } else {
        fill_preimage = AttestedFill {
            program: crate::ID.to_bytes(),
            domain: opened.domain,
            intent: release.intent.key().to_bytes(),
            payee: payee.key().to_bytes(),
            amount_in: opened.tally.amount_in,
            result,
            filled: opened.prior.0,
            revision: opened.prior.1,
            max_fee_bps,
            ext_hash,
        }
        .preimage();
        &fill_preimage
    };
    let signers = judge.signers(&opened.attestor)?;
    match judge {
        Judge::Key => verify_preceding_ed25519(
            &release.instructions,
            &opened.attestor,
            &offchain_envelope(
                &opened.attestor.to_bytes(),
                &solana_sha256_hasher::hashv(&[preimage]).to_bytes(),
            ),
        )?,
        Judge::Committee { .. } => verify_preceding_cosign(
            &release.instructions,
            &judge.eligible(&opened.attestor),
            &signers,
            &solana_sha256_hasher::hashv(&[&COMMITTEE_COSIGN_TAG, preimage]).to_bytes(),
        )?,
    }
    let stake = honor_on_release(
        opened.claims,
        release.claims,
        release.stake_to.as_ref(),
        &payee_wallet(&payee, &release, opened.claims)?,
        opened.now,
    )?;
    if delivered.is_some() {
        mark_paid(&release, opening, opened.now, [0u8; 32])?;
    }
    let mut withheld = Vec::new();
    pay_judge(
        &release,
        &opened,
        judge.fee_owner(opened.attestor),
        &mut withheld,
    )?;
    let settle_amount = opened
        .tally
        .amount_in
        .checked_sub(opened.judge_fee)
        .ok_or(EngineError::Overflow)?;
    let settled = pay_out(
        Payout {
            token_program: release.input_token_program,
            vault: release.vault,
            mint: release.input_mint,
            fee_to: release.fee_to,
            partner_to: release.partner_to,
            payee,
            intent: release.intent.to_account_info(),
            signer: &opened.signer,
        },
        settle_amount,
        opened.terms,
        max_fee_bps,
    )?;
    push_withheld(&mut withheld, &settled);
    settle_mint_cap(release.vault, before, release.mint_cap, release.intent)?;
    Ok(Released {
        owner: opened.signer.owner,
        attestor: opened.attestor,
        signers,
        tally: opened.tally,
        fees: settled.fees,
        withheld,
        stake,
        delivered,
    })
}

pub struct SplitReleased {
    pub released: Released,
    pub recipients: u8,
    pub split_hash: [u8; 32],
    pub held: Vec<HeldShare>,
}

fn push_withheld(withheld: &mut Vec<Withheld>, settled: &Settled) {
    for leg in settled.withheld.into_iter().flatten() {
        withheld.push(Withheld {
            payee: leg.payee,
            account: leg.account,
            fee: leg.fee,
            role: leg.role,
        });
    }
}

pub fn release_split<'info>(
    release: Release<'_, 'info>,
    recipients: &[Option<AccountInfo<'info>>; MAX_SPLIT_RECIPIENTS],
    judge: &Judge,
    fill: Fill,
    claim: &SplitClaim,
    opening: &Opening,
    ext: &Ext,
) -> Result<SplitReleased> {
    let Fill {
        amount_in,
        result,
        max_fee_bps,
    } = fill;
    ext.check(FILL_EXT_TAGS)?;
    let len = claim.recipients.len();
    require!(
        len > 0 && len <= MAX_SPLIT_RECIPIENTS,
        EngineError::SplitCountMismatch
    );
    require!(claim.weights.len() == len, EngineError::SplitCountMismatch);
    let mut recipients_info = Vec::with_capacity(len);
    for (i, slot) in recipients.iter().enumerate() {
        require!(slot.is_some() == (i < len), EngineError::SplitCountMismatch);
        if let (Some(info), Some(wallet)) = (slot, claim.recipients.get(i)) {
            recipients_info.push((info.clone(), *wallet));
        }
    }
    let opened = open(&release, amount_in, result)?;
    require!(opened.spec_hash != [0u8; 32], EngineError::NotAProof);
    let delivered = announced(&release, opening)?;
    require!(
        claim.recipients.contains(&delivered.worker),
        EngineError::AnnouncerNotRecipient
    );
    let split_hash = {
        let wallets: Vec<[u8; 32]> = claim.recipients.iter().map(Pubkey::to_bytes).collect();
        let (buf, used) = split_hash_preimage(&wallets, &claim.weights).map_err(core_err)?;
        solana_sha256_hasher::hashv(&[buf.get(..used).ok_or(EngineError::SplitCountMismatch)?])
            .to_bytes()
    };
    let ext_hash = solana_sha256_hasher::hashv(&[&ext.0]).to_bytes();
    let digest = {
        let preimage = AttestedSplitDelivery {
            program: crate::ID.to_bytes(),
            domain: opened.domain,
            intent: release.intent.key().to_bytes(),
            amount_in: opened.tally.amount_in,
            result,
            filled: opened.prior.0,
            revision: opened.prior.1,
            max_fee_bps,
            ext_hash,
            spec_hash: opened.spec_hash,
            split_hash,
            announcement: delivered.announcement.to_bytes(),
            seq: delivered.seq,
            delivered: opening.delivered,
            salt: opening.salt,
        }
        .preimage();
        solana_sha256_hasher::hashv(&[&SPLIT_COSIGN_TAG, &preimage]).to_bytes()
    };
    let signers = judge.signers(&opened.attestor)?;
    let mut listed = claim.recipients.clone();
    listed.extend(judge.eligible(&opened.attestor));
    let mut cosigners = claim.recipients.clone();
    cosigners.extend_from_slice(&signers);
    verify_preceding_cosign(&release.instructions, &listed, &cosigners, &digest)?;
    for (info, wallet) in recipients_info.iter() {
        let canonical = get_associated_token_address_with_program_id(
            wallet,
            &release.input_mint.key(),
            &release.input_token_program.key(),
        );
        require!(info.key() == canonical, EngineError::RecipientNotCanonical);
    }
    let stake = honor_on_release(
        opened.claims,
        release.claims,
        release.stake_to.as_ref(),
        &claim.recipients,
        opened.now,
    )?;
    mark_paid(&release, opening, opened.now, split_hash)?;
    let settle_amount = opened
        .tally
        .amount_in
        .checked_sub(opened.judge_fee)
        .ok_or(EngineError::Overflow)?;
    let before = release.vault.amount;
    let mut withheld = Vec::new();
    let judge_paid = pay_judge(
        &release,
        &opened,
        judge.fee_owner(opened.attestor),
        &mut withheld,
    )?;
    let (settled, held) = pay_out_split(
        SplitPayout {
            token_program: release.input_token_program,
            vault: release.vault,
            mint: release.input_mint,
            fee_to: release.fee_to,
            partner_to: release.partner_to,
            recipients: &recipients_info,
            intent: release.intent.to_account_info(),
            signer: &opened.signer,
        },
        settle_amount,
        opened.terms,
        max_fee_bps,
        &claim.weights,
    )?;
    let fees = settled.fees;
    push_withheld(&mut withheld, &settled);
    let held_total = held
        .iter()
        .try_fold(0u64, |sum, share| sum.checked_add(share.share))
        .ok_or(EngineError::Overflow)?;
    let left = [fees.protocol, fees.partner, fees.net]
        .iter()
        .try_fold(judge_paid, |sum, leg| sum.checked_add(*leg))
        .and_then(|sum| sum.checked_sub(held_total))
        .ok_or(EngineError::Overflow)?;
    if !held.is_empty() {
        let mask = held
            .iter()
            .fold(0u8, |mask, share| mask | (1u8 << share.index));
        release
            .announcement
            .ok_or(EngineError::AnnouncementMissing)?
            .load_mut()?
            .held = mask;
        release.intent.load_mut()?.held = 1;
    }
    let expected = before
        .checked_sub(left)
        .ok_or(EngineError::SplitNotConserved)?;
    release.vault.reload()?;
    require!(
        release.vault.amount == expected,
        EngineError::SplitNotConserved
    );
    release_mint_cap(release.mint_cap, release.intent, left)?;
    Ok(SplitReleased {
        released: Released {
            owner: opened.signer.owner,
            attestor: opened.attestor,
            signers,
            tally: opened.tally,
            fees,
            withheld,
            stake,
            delivered: Some(delivered),
        },
        recipients: u8::try_from(len).map_err(|_| EngineError::SplitCountMismatch)?,
        split_hash,
        held,
    })
}
