use anchor_lang::prelude::Pubkey;
use intent_core::kinds::{attested_result, limit_order, Kind};
use intent_engine::errors::EngineError;
use intent_engine::events::{
    EconomicsUpdated, FeeWithheld, FillBegun, IntentAttested, IntentClosed, IntentCreated,
    IntentExpired, IntentFilled, WITHHELD_PARTNER,
};
use intent_engine::state::{
    Intent, BPS, MAX_ATTESTED_FEE_BPS, MAX_CRANK_BOUNTY, MAX_CREATE_FEE, MAX_FEE_BPS,
};
use intent_engine::Economics;
use litesvm::types::TransactionMetadata;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    attestation_message, canonical_refund, ed25519_ix, empty_ext_hash, engine_error,
    engine_error_at, events, intent_pda, partner_ext, swap_spec, vault_pda, Env, IntentSpec,
    Market, MintExt, Solver, TestResult, Trader, DOMAIN, START_TS,
};

const PROGRAM: Pubkey = anchor_spl::token::ID;
const FUNDED: u64 = 1_000_000;
const LARGE: u64 = 100_000;
const ESCROW: u64 = 400;
const BOUNTY: u32 = 70_000;
const CREATE_FEE: u32 = 30_000;
const SUBMIT_BY: i64 = START_TS + 600;

struct World {
    env: Env,
    market: Market,
    trader: Trader,
    solver: Solver,
    fee_to: Pubkey,
}

fn economics(crank_bounty: u32, create_fee: u32) -> Economics {
    Economics {
        kind_fee_mask: 0,
        kind_fee_bps: [0; 4],
        partner_cut_bps: 0,
        crank_bounty,
        create_fee,
    }
}

fn world() -> TestResult<World> {
    world_with(&[])
}

fn world_with(input: &[MintExt]) -> TestResult<World> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(PROGRAM, input, PROGRAM, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let solver = env.solver(&market, 1_000_000)?;
    let fee_to = env.fee_account(&market)?;
    Ok(World {
        env,
        market,
        trader,
        solver,
        fee_to,
    })
}

impl World {
    fn owner(&self) -> Pubkey {
        self.trader.key.pubkey()
    }

    fn set(&mut self, e: Economics) -> Result<TransactionMetadata, TransactionError> {
        let admin = self.env.authority.insecure_clone();
        let ix = self.env.economics_ix(&admin.pubkey(), e);
        self.env.send(&admin, &[ix], &[])
    }

    fn create(&mut self, nonce: u64) -> TestResult<TransactionMetadata> {
        let spec = swap_spec(nonce, ESCROW)?;
        Ok(self.env.create_intent(&self.trader, &self.market, &spec)?)
    }

    fn rent(&self) -> u64 {
        self.env
            .svm
            .minimum_balance_for_rent_exemption(Intent::SPACE)
    }

    fn intent_lamports(&self, nonce: u64) -> u64 {
        self.env.lamports(&intent_pda(&self.owner(), nonce))
    }

    fn sponsored(
        &mut self,
        ixs: &[solana_instruction::Instruction],
        signer: &Keypair,
    ) -> Result<TransactionMetadata, TransactionError> {
        let payer = self
            .env
            .funded()
            .map_err(|_| TransactionError::AccountNotFound)?;
        self.env.send(&payer, ixs, &[signer])
    }

    fn fill(&mut self, nonce: u64) -> TestResult {
        let ix = self.env.fill_ix(
            &self.solver,
            &self.owner(),
            &self.market,
            nonce,
            &self.trader.receiver,
            Some(&self.fee_to),
            ESCROW,
        );
        let solver = self.solver.key.insecure_clone();
        self.env.send(&solver, &[ix], &[])?;
        Ok(())
    }
}

#[test]
fn only_the_admin_sets_economics_and_every_bound_holds_at_its_edge() -> TestResult {
    let mut w = world()?;
    let at_limit = Economics {
        kind_fee_mask: 0b1_1110,
        kind_fee_bps: [MAX_FEE_BPS; 4],
        partner_cut_bps: BPS,
        crank_bounty: MAX_CRANK_BOUNTY,
        create_fee: MAX_CREATE_FEE,
    };
    let meta = w.set(at_limit)?;
    let c = w.env.config()?;
    assert_eq!(
        (
            c.kind_fee_mask,
            c.kind_fee_bps,
            c.partner_cut_bps,
            c.crank_bounty,
            c.create_fee
        ),
        (
            0b1_1110,
            [MAX_FEE_BPS; 4],
            BPS,
            MAX_CRANK_BOUNTY,
            MAX_CREATE_FEE
        )
    );
    let e = events::<EconomicsUpdated>(&meta).pop().ok_or("missing")?;
    assert_eq!(
        (
            e.kind_fee_mask,
            e.kind_fee_bps,
            e.partner_cut_bps,
            e.crank_bounty,
            e.create_fee
        ),
        (
            0b1_1110,
            [MAX_FEE_BPS; 4],
            BPS,
            MAX_CRANK_BOUNTY,
            MAX_CREATE_FEE
        )
    );
    let over = [
        (
            Economics {
                kind_fee_mask: 0b1,
                ..at_limit
            },
            EngineError::UnknownKindBits,
        ),
        (
            Economics {
                kind_fee_mask: 0b10_0000,
                ..at_limit
            },
            EngineError::UnknownKindBits,
        ),
        (
            Economics {
                kind_fee_bps: [0, 0, 0, MAX_ATTESTED_FEE_BPS + 1],
                ..at_limit
            },
            EngineError::FeeTooHigh,
        ),
        (
            Economics {
                kind_fee_bps: [MAX_FEE_BPS + 1, 0, 0, 0],
                ..at_limit
            },
            EngineError::FeeTooHigh,
        ),
        (
            Economics {
                partner_cut_bps: BPS + 1,
                ..at_limit
            },
            EngineError::PartnerCutTooHigh,
        ),
        (
            Economics {
                crank_bounty: MAX_CRANK_BOUNTY + 1,
                ..at_limit
            },
            EngineError::CrankBountyTooHigh,
        ),
        (
            Economics {
                create_fee: MAX_CREATE_FEE + 1,
                ..at_limit
            },
            EngineError::CreateFeeTooHigh,
        ),
    ];
    for (i, (e, err)) in over.into_iter().enumerate() {
        assert_eq!(w.set(e).err(), Some(engine_error(err)), "case {i}");
    }
    let stranger = w.env.funded()?;
    let ix = w.env.economics_ix(&stranger.pubkey(), economics(1, 1));
    assert_eq!(
        w.env.send(&stranger, &[ix], &[]).err(),
        Some(engine_error(EngineError::Unauthorized))
    );
    assert_eq!(w.env.config()?.crank_bounty, MAX_CRANK_BOUNTY);
    assert_eq!(
        (MAX_CRANK_BOUNTY, MAX_CREATE_FEE, BPS),
        (10_000_000, 10_000_000, 10_000)
    );
    Ok(())
}

#[test]
fn a_create_pays_the_fee_to_the_treasury_and_escrows_the_bounty_in_the_intent() -> TestResult {
    let mut w = world()?;
    w.create(0)?;
    assert_eq!(w.intent_lamports(0), w.rent());
    assert_eq!(w.env.intent(&w.owner(), 0)?.bounty, 0);
    w.set(economics(BOUNTY, CREATE_FEE))?;
    let treasury = w.env.lamports(&w.env.fee_recipient);
    let meta = w.create(1)?;
    assert_eq!(
        w.env.lamports(&w.env.fee_recipient),
        treasury + u64::from(CREATE_FEE)
    );
    assert_eq!(w.intent_lamports(1), w.rent() + u64::from(BOUNTY));
    assert_eq!(w.env.intent(&w.owner(), 1)?.bounty, BOUNTY);
    let e = events::<IntentCreated>(&meta).pop().ok_or("missing")?;
    assert_eq!((e.bounty, e.create_fee), (BOUNTY, CREATE_FEE));
    Ok(())
}

#[test]
fn a_signed_create_charges_the_relayer_not_the_owner() -> TestResult {
    let mut w = world()?;
    w.set(economics(BOUNTY, CREATE_FEE))?;
    let relayer = w.env.funded()?;
    w.env.approve_delegate(&w.trader, &w.market, ESCROW)?;
    let spec = swap_spec(5, ESCROW)?;
    let message = w
        .env
        .signed_message(&w.trader, &w.market, &spec, DOMAIN, SUBMIT_BY);
    let create = w
        .env
        .create_signed_ix(&relayer.pubkey(), &w.trader, &w.market, &spec, SUBMIT_BY);
    let owner_lamports = w.env.lamports(&w.owner());
    let treasury = w.env.lamports(&w.env.fee_recipient);
    w.env.send(
        &relayer,
        &[ed25519_ix(&w.trader.key, &message), create],
        &[],
    )?;
    assert_eq!(w.env.lamports(&w.owner()), owner_lamports);
    assert_eq!(
        w.env.lamports(&w.env.fee_recipient),
        treasury + u64::from(CREATE_FEE)
    );
    assert_eq!(w.intent_lamports(5), w.rent() + u64::from(BOUNTY));
    Ok(())
}

#[test]
fn a_create_naming_any_other_treasury_is_refused() -> TestResult {
    let mut w = world()?;
    w.set(economics(BOUNTY, CREATE_FEE))?;
    let thief = w.env.funded()?;
    let mut ix = w
        .env
        .create_intent_ix(&w.trader, &w.market, &swap_spec(2, ESCROW)?);
    if let Some(meta) = ix
        .accounts
        .iter_mut()
        .find(|meta| meta.pubkey == w.env.fee_recipient)
    {
        meta.pubkey = thief.pubkey();
    }
    let key = w.trader.key.insecure_clone();
    assert_eq!(
        w.env.send(&key, &[ix], &[]).err(),
        Some(engine_error(EngineError::TreasuryMismatch))
    );
    Ok(())
}

#[test]
fn the_cranker_who_expires_an_intent_earns_its_bounty_once() -> TestResult {
    let mut w = world()?;
    w.set(economics(BOUNTY, 0))?;
    w.create(0)?;
    w.set(economics(1, 0))?;
    w.env.set_now(START_TS + 3_600);
    let cranker = w.env.funded()?;
    let before = w.env.lamports(&cranker.pubkey());
    let expire = w.env.expire_ix(
        &cranker.pubkey(),
        &w.owner(),
        &w.market,
        0,
        &canonical_refund(&w.owner(), &w.market),
    );
    let meta = w.sponsored(&[expire], &cranker)?;
    assert_eq!(
        w.env.lamports(&cranker.pubkey()),
        before + u64::from(BOUNTY)
    );
    assert_eq!(w.intent_lamports(0), w.rent());
    assert_eq!(w.env.intent(&w.owner(), 0)?.bounty, 0);
    let e = events::<IntentExpired>(&meta).pop().ok_or("missing")?;
    assert_eq!((e.by, e.bounty), (cranker.pubkey(), BOUNTY));
    let closer = w.env.funded()?;
    let closer_before = w.env.lamports(&closer.pubkey());
    let owner_before = w.env.lamports(&w.owner());
    let close = w
        .env
        .close_ix_by(&closer.pubkey(), &w.owner(), &w.market, 0, &w.trader.input);
    let meta = w.sponsored(&[close], &closer)?;
    assert_eq!(w.env.lamports(&closer.pubkey()), closer_before);
    assert!(w.env.lamports(&w.owner()) >= owner_before + w.rent());
    let e = events::<IntentClosed>(&meta).pop().ok_or("missing")?;
    assert_eq!((e.by, e.bounty), (closer.pubkey(), 0));
    Ok(())
}

#[test]
fn a_filled_intent_pays_its_closer_and_a_cancelled_one_returns_the_bounty_to_its_payer(
) -> TestResult {
    let mut w = world()?;
    w.set(economics(BOUNTY, 0))?;
    w.create(0)?;
    w.create(1)?;
    w.fill(0)?;
    let cancel = w.env.cancel_ix(&w.owner(), &w.market, 1, &w.trader.input);
    let key = w.trader.key.insecure_clone();
    w.env.send(&key, &[cancel], &[])?;
    let vault_rent = w.env.svm.minimum_balance_for_rent_exemption(165);
    for (nonce, filled) in [(0, true), (1, false)] {
        let closer = w.env.funded()?;
        let closer_before = w.env.lamports(&closer.pubkey());
        let owner_before = w.env.lamports(&w.owner());
        let close = w.env.close_ix_by(
            &closer.pubkey(),
            &w.owner(),
            &w.market,
            nonce,
            &w.trader.input,
        );
        let meta = w.sponsored(&[close], &closer)?;
        let (to_closer, to_payer) = if filled {
            (u64::from(BOUNTY), 0)
        } else {
            (0, u64::from(BOUNTY))
        };
        assert_eq!(
            w.env.lamports(&closer.pubkey()),
            closer_before + to_closer,
            "{nonce}"
        );
        assert_eq!(
            w.env.lamports(&w.owner()),
            owner_before + w.rent() + vault_rent + to_payer,
            "{nonce}"
        );
        let e = events::<IntentClosed>(&meta).pop().ok_or("missing")?;
        let earner = if filled { closer.pubkey() } else { w.owner() };
        assert_eq!(
            (e.by, e.bounty, e.bounty_to),
            (closer.pubkey(), BOUNTY, earner)
        );
    }
    Ok(())
}

#[test]
fn a_bounty_is_fixed_when_the_intent_is_created() -> TestResult {
    let mut w = world()?;
    w.set(economics(BOUNTY, 0))?;
    w.create(0)?;
    w.set(economics(MAX_CRANK_BOUNTY, 0))?;
    assert_eq!(w.env.intent(&w.owner(), 0)?.bounty, BOUNTY);
    w.set(economics(0, 0))?;
    w.fill(0)?;
    let closer = w.env.funded()?;
    let before = w.env.lamports(&closer.pubkey());
    let close = w
        .env
        .close_ix_by(&closer.pubkey(), &w.owner(), &w.market, 0, &w.trader.input);
    w.sponsored(&[close], &closer)?;
    assert_eq!(w.env.lamports(&closer.pubkey()), before + u64::from(BOUNTY));
    Ok(())
}

fn spec_with(nonce: u64, kind: Kind, ext: Vec<u8>, attestor: &Pubkey) -> TestResult<IntentSpec> {
    let err = |e: intent_core::Error| format!("{e:?}");
    let params = match kind {
        Kind::LimitOrder => limit_order::Params {
            make_amount: LARGE,
            take_amount: 1,
        }
        .encode()
        .map_err(err)?,
        Kind::AttestedResult => attested_result::Params {
            amount_in: LARGE,
            min_result: 1,
            max_result: 9,
            attestor: attestor.to_bytes(),
            spec_hash: [0; 32],
            judge_fee: 0,
        }
        .encode()
        .map_err(err)?,
        _ => swap_spec(nonce, LARGE)?.params,
    };
    Ok(IntentSpec {
        nonce,
        kind: kind as u8,
        params,
        expires_at: START_TS + 3_600,
        flags: 0,
        ext,
    })
}

impl World {
    fn create_spec(&mut self, spec: &IntentSpec) -> TestResult<TransactionMetadata> {
        Ok(self.env.create_intent(&self.trader, &self.market, spec)?)
    }

    fn fill_ix(&self, nonce: u64) -> Instruction {
        self.env.fill_ix(
            &self.solver,
            &self.owner(),
            &self.market,
            nonce,
            &self.trader.receiver,
            Some(&self.fee_to),
            ESCROW,
        )
    }

    fn flash_ixs(&self, nonce: u64) -> Vec<Instruction> {
        let me = self.solver.key.pubkey();
        vec![
            self.env.begin_fill_ix(
                &me,
                &self.owner(),
                &self.market,
                nonce,
                &self.solver.input,
                Some(&self.fee_to),
                1,
            ),
            self.env.end_fill_ix(
                &me,
                &self.owner(),
                &self.market,
                nonce,
                &self.trader.receiver,
                &self.solver.output,
                ESCROW,
            ),
        ]
    }

    fn attested_ixs(&self, nonce: u64, attestor: &Keypair) -> Vec<Instruction> {
        let message = attestation_message(
            DOMAIN,
            &attestor.pubkey(),
            &intent_pda(&self.owner(), nonce),
            &self.solver.input,
            LARGE,
            5,
        );
        vec![
            ed25519_ix(attestor, &message),
            self.env.fill_attested_ix(
                &self.solver.key.pubkey(),
                &self.owner(),
                &self.market,
                nonce,
                &self.solver.input,
                Some(&self.fee_to),
                5,
            ),
        ]
    }

    fn as_solver(&mut self, ixs: &[Instruction]) -> Result<TransactionMetadata, TransactionError> {
        let solver = self.solver.key.insecure_clone();
        self.env.send(&solver, ixs, &[])
    }
}

#[test]
fn a_kind_fee_overrides_the_default_only_for_the_kinds_it_names() -> TestResult {
    let mut w = world()?;
    let attestor = Keypair::new();
    w.set(Economics {
        kind_fee_mask: u8::try_from(Kind::SwapExactIn.bit() | Kind::AttestedResult.bit())?,
        kind_fee_bps: [7, 99, 99, 0],
        ..economics(0, 0)
    })?;
    w.create_spec(&spec_with(
        0,
        Kind::SwapExactIn,
        Vec::new(),
        &attestor.pubkey(),
    )?)?;
    w.create_spec(&spec_with(
        1,
        Kind::LimitOrder,
        Vec::new(),
        &attestor.pubkey(),
    )?)?;
    w.create_spec(&spec_with(
        2,
        Kind::AttestedResult,
        Vec::new(),
        &attestor.pubkey(),
    )?)?;
    let fee_before = w.env.balance(&w.fee_to)?;
    let swap = w.fill_ix(0);
    let meta = w.as_solver(&[swap])?;
    assert_eq!(w.env.balance(&w.fee_to)?, fee_before + 70);
    let e = events::<IntentFilled>(&meta).pop().ok_or("missing")?;
    assert_eq!((e.fee, e.partner_fee, e.net), (70, 0, LARGE - 70));
    let limit = w.fill_ix(1);
    w.as_solver(&[limit])?;
    assert_eq!(w.env.balance(&w.fee_to)?, fee_before + 70 + 50);
    let attested = w.attested_ixs(2, &attestor);
    let meta = w.as_solver(&attested)?;
    assert_eq!(w.env.balance(&w.fee_to)?, fee_before + 70 + 50);
    let e = events::<IntentAttested>(&meta).pop().ok_or("missing")?;
    assert_eq!((e.fee, e.net), (0, LARGE));
    Ok(())
}

const PARTNER_BPS: u16 = 50;
const CUT_BPS: u16 = 2_000;

fn partnered() -> TestResult<(World, Pubkey, Pubkey, Keypair)> {
    partnered_with(&[])
}

fn partnered_with(input: &[MintExt]) -> TestResult<(World, Pubkey, Pubkey, Keypair)> {
    let mut w = world_with(input)?;
    w.set(Economics {
        partner_cut_bps: CUT_BPS,
        ..economics(0, 0)
    })?;
    let partner = Pubkey::new_unique();
    let partner_to = w
        .env
        .create_ata(&partner, &w.market.input_mint, w.market.input_program)?;
    w.env.partner_to = Some(partner_to);
    let attestor = Keypair::new();
    let ext = partner_ext(&partner, PARTNER_BPS);
    w.create_spec(&spec_with(
        0,
        Kind::SwapExactIn,
        ext.clone(),
        &attestor.pubkey(),
    )?)?;
    w.create_spec(&spec_with(
        1,
        Kind::SwapExactIn,
        ext.clone(),
        &attestor.pubkey(),
    )?)?;
    w.create_spec(&spec_with(
        2,
        Kind::AttestedResult,
        ext,
        &attestor.pubkey(),
    )?)?;
    Ok((w, partner, partner_to, attestor))
}

#[test]
fn a_partner_named_at_create_earns_its_share_less_the_protocol_cut_on_every_fill_path() -> TestResult
{
    let (mut w, partner, partner_to, attestor) = partnered()?;
    let stored = w.env.intent(&w.owner(), 0)?;
    assert_eq!((stored.partner, stored.partner_bps), (partner, PARTNER_BPS));
    let fee_before = w.env.balance(&w.fee_to)?;
    let fill = w.fill_ix(0);
    let meta = w.as_solver(&[fill])?;
    let e = events::<IntentFilled>(&meta).pop().ok_or("missing")?;
    assert_eq!((e.fee, e.partner_fee, e.net), (150, 400, 99_450));
    assert_eq!(w.env.balance(&partner_to)?, 400);
    assert_eq!(w.env.balance(&w.fee_to)?, fee_before + 150);
    let flash = w.flash_ixs(1);
    let meta = w.as_solver(&flash)?;
    let e = events::<FillBegun>(&meta).pop().ok_or("missing")?;
    assert_eq!((e.fee, e.partner_fee, e.net), (150, 400, 99_450));
    let attested = w.attested_ixs(2, &attestor);
    let meta = w.as_solver(&attested)?;
    let e = events::<IntentAttested>(&meta).pop().ok_or("missing")?;
    assert_eq!((e.fee, e.partner_fee, e.net), (150, 400, 99_450));
    assert_eq!(w.env.balance(&partner_to)?, 1_200);
    assert_eq!(w.env.balance(&w.fee_to)?, fee_before + 450);
    Ok(())
}

#[test]
fn a_partner_share_needs_the_partners_own_canonical_account_on_every_fill_path() -> TestResult {
    let (mut w, _, partner_to, attestor) = partnered()?;
    let impostor = w.env.create_ata(
        &Pubkey::new_unique(),
        &w.market.input_mint,
        w.market.input_program,
    )?;
    for (to, err) in [
        (None, EngineError::PartnerAccountMissing),
        (Some(impostor), EngineError::PartnerAccountNotCanonical),
    ] {
        w.env.partner_to = to;
        let fill = w.fill_ix(0);
        assert_eq!(w.as_solver(&[fill]).err(), Some(engine_error(err)));
        let flash = w.flash_ixs(1);
        assert_eq!(w.as_solver(&flash).err(), Some(engine_error(err)));
        let attested = w.attested_ixs(2, &attestor);
        assert_eq!(w.as_solver(&attested).err(), Some(engine_error_at(1, err)));
    }
    w.env.partner_to = Some(partner_to);
    let fill = w.fill_ix(0);
    w.as_solver(&[fill])?;
    Ok(())
}

#[test]
fn a_partner_share_its_account_cannot_take_stays_for_the_owner_and_is_reported_on_every_fill_path(
) -> TestResult {
    let (mut w, partner, partner_to, attestor) = partnered_with(&[MintExt::Freezable])?;
    w.env
        .set_frozen(&partner_to, &w.market.input_mint, PROGRAM, true)?;
    let fee_before = w.env.balance(&w.fee_to)?;
    let fill = w.fill_ix(0);
    let filled = w.as_solver(&[fill])?;
    let e = events::<IntentFilled>(&filled).pop().ok_or("missing")?;
    assert_eq!((e.fee, e.partner_fee, e.net), (150, 0, 99_450));
    let flash = w.flash_ixs(1);
    let begun = w.as_solver(&flash)?;
    let e = events::<FillBegun>(&begun).pop().ok_or("missing")?;
    assert_eq!((e.fee, e.partner_fee, e.net), (150, 0, 99_450));
    let attested = w.attested_ixs(2, &attestor);
    let landed = w.as_solver(&attested)?;
    let e = events::<IntentAttested>(&landed).pop().ok_or("missing")?;
    assert_eq!((e.fee, e.partner_fee, e.net), (150, 0, 99_450));
    for (nonce, meta) in [(0, &filled), (1, &begun), (2, &landed)] {
        let intent = intent_pda(&w.owner(), nonce);
        let withheld: Vec<_> = events::<FeeWithheld>(meta)
            .into_iter()
            .map(|e| (e.intent, e.payee, e.account, e.fee, e.role))
            .collect();
        assert_eq!(
            withheld,
            [(intent, partner, partner_to, 400, WITHHELD_PARTNER)]
        );
        assert_eq!(w.env.balance(&vault_pda(&intent))?, 400);
    }
    assert_eq!(w.env.balance(&partner_to)?, 0);
    assert_eq!(w.env.balance(&w.fee_to)?, fee_before + 450);
    Ok(())
}

#[test]
fn a_solver_bounds_the_protocol_and_partner_fees_together() -> TestResult {
    let (mut w, _, _, _) = partnered()?;
    w.env.max_fee_bps = 5 + PARTNER_BPS - 1;
    let fill = w.fill_ix(0);
    assert_eq!(
        w.as_solver(&[fill]).err(),
        Some(engine_error(EngineError::FeeAboveBound))
    );
    w.env.max_fee_bps = 5 + PARTNER_BPS;
    let fill = w.fill_ix(0);
    w.as_solver(&[fill])?;
    Ok(())
}

#[test]
fn a_malformed_or_greedy_partner_is_refused_at_create() -> TestResult {
    let mut w = world()?;
    let attestor = Pubkey::new_unique();
    let partner = Pubkey::new_unique();
    let mut wrong_len = partner_ext(&partner, 5);
    wrong_len.push(0);
    if let Some(len) = wrong_len.get_mut(1) {
        *len = 35;
    }
    for (ext, err) in [
        (partner_ext(&partner, 101), EngineError::PartnerFeeTooHigh),
        (partner_ext(&partner, 0), EngineError::ExtMalformed),
        (
            partner_ext(&Pubkey::default(), 5),
            EngineError::ExtMalformed,
        ),
        (wrong_len, EngineError::ExtMalformed),
    ] {
        let spec = spec_with(0, Kind::SwapExactIn, ext, &attestor)?;
        assert_eq!(
            w.env.create_intent(&w.trader, &w.market, &spec).err(),
            Some(engine_error(err))
        );
    }
    let spec = spec_with(0, Kind::SwapExactIn, partner_ext(&partner, 100), &attestor)?;
    w.env.create_intent(&w.trader, &w.market, &spec)?;
    let stored = w.env.intent(&w.owner(), 0)?;
    assert_eq!((stored.partner, stored.partner_bps), (partner, 100));
    Ok(())
}

#[test]
fn a_relayer_cannot_strip_or_swap_the_partner_an_owner_signed() -> TestResult {
    let mut w = world()?;
    let relayer = w.env.funded()?;
    w.env.approve_delegate(&w.trader, &w.market, LARGE)?;
    let attestor = Pubkey::new_unique();
    let partner = Pubkey::new_unique();
    let signed = spec_with(4, Kind::SwapExactIn, partner_ext(&partner, 30), &attestor)?;
    let message = w
        .env
        .signed_message(&w.trader, &w.market, &signed, DOMAIN, SUBMIT_BY);
    for ext in [
        Vec::new(),
        partner_ext(&relayer.pubkey(), 30),
        partner_ext(&partner, 31),
    ] {
        let tampered = spec_with(4, Kind::SwapExactIn, ext, &attestor)?;
        let create = w.env.create_signed_ix(
            &relayer.pubkey(),
            &w.trader,
            &w.market,
            &tampered,
            SUBMIT_BY,
        );
        assert_eq!(
            w.env
                .send(
                    &relayer,
                    &[ed25519_ix(&w.trader.key, &message), create],
                    &[]
                )
                .err(),
            Some(engine_error_at(1, EngineError::SigMessage))
        );
    }
    let create =
        w.env
            .create_signed_ix(&relayer.pubkey(), &w.trader, &w.market, &signed, SUBMIT_BY);
    w.env.send(
        &relayer,
        &[ed25519_ix(&w.trader.key, &message), create],
        &[],
    )?;
    assert_eq!(w.env.intent(&w.owner(), 4)?.partner, partner);
    Ok(())
}

#[test]
fn an_open_intent_keeps_the_partner_cut_it_was_created_under() -> TestResult {
    let mut w = world()?;
    let partner = Pubkey::new_unique();
    let partner_to = w
        .env
        .create_ata(&partner, &w.market.input_mint, w.market.input_program)?;
    w.env.partner_to = Some(partner_to);
    let attestor = Keypair::new();
    let spec = |nonce| {
        spec_with(
            nonce,
            Kind::SwapExactIn,
            partner_ext(&partner, PARTNER_BPS),
            &attestor.pubkey(),
        )
    };
    w.create_spec(&spec(0)?)?;
    assert_eq!(w.env.intent(&w.owner(), 0)?.partner_cut_bps, 0);
    w.set(Economics {
        partner_cut_bps: BPS,
        ..economics(0, 0)
    })?;
    w.create_spec(&spec(1)?)?;
    assert_eq!(w.env.intent(&w.owner(), 1)?.partner_cut_bps, BPS);
    let before = w.env.balance(&partner_to)?;
    let fill = w.fill_ix(0);
    let e = events::<IntentFilled>(&w.as_solver(&[fill])?)
        .pop()
        .ok_or("missing")?;
    assert!(e.partner_fee > 0);
    assert_eq!(
        Some(w.env.balance(&partner_to)?),
        before.checked_add(e.partner_fee)
    );
    let fill = w.fill_ix(1);
    let e = events::<IntentFilled>(&w.as_solver(&[fill])?)
        .pop()
        .ok_or("missing")?;
    assert_eq!(e.partner_fee, 0);
    Ok(())
}

#[test]
fn a_dust_intent_whose_fees_round_past_its_amount_cannot_fill_but_still_cancels() -> TestResult {
    let mut w = world()?;
    let partner = Pubkey::new_unique();
    w.env.partner_to = Some(w.env.create_ata(
        &partner,
        &w.market.input_mint,
        w.market.input_program,
    )?);
    let attestor = Keypair::new();
    let spec = IntentSpec {
        params: intent_core::kinds::swap_exact_in::Params {
            amount_in: 1,
            min_out: 1,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ..spec_with(
            0,
            Kind::SwapExactIn,
            partner_ext(&partner, PARTNER_BPS),
            &attestor.pubkey(),
        )?
    };
    w.create_spec(&spec)?;
    let fill = w.fill_ix(0);
    assert!(w.as_solver(&[fill]).is_err());
    let owner = w.owner();
    let before = w.env.balance(&w.trader.input)?;
    let cancel = w.env.cancel_ix(&owner, &w.market, 0, &w.trader.input);
    let key = w.trader.key.insecure_clone();
    w.env.send(&key, &[cancel], &[])?;
    assert_eq!(Some(w.env.balance(&w.trader.input)?), before.checked_add(1));
    Ok(())
}

fn attested_fee(bps: u16) -> Economics {
    Economics {
        kind_fee_mask: 0b1_0000,
        kind_fee_bps: [0, 0, 0, bps],
        ..economics(0, 0)
    }
}

#[test]
fn economics_accepts_a_three_percent_attested_fee() -> TestResult {
    let mut w = world()?;
    assert_eq!(MAX_ATTESTED_FEE_BPS, 300);
    w.set(Economics {
        kind_fee_bps: [MAX_FEE_BPS, MAX_FEE_BPS, MAX_FEE_BPS, MAX_ATTESTED_FEE_BPS],
        ..attested_fee(0)
    })?;
    assert_eq!(
        w.env.config()?.kind_fee_bps,
        [MAX_FEE_BPS, MAX_FEE_BPS, MAX_FEE_BPS, MAX_ATTESTED_FEE_BPS]
    );
    Ok(())
}

#[test]
fn economics_refuses_an_attested_fee_above_three_percent() -> TestResult {
    let mut w = world()?;
    assert_eq!(
        w.set(attested_fee(MAX_ATTESTED_FEE_BPS + 1)).err(),
        Some(engine_error(EngineError::FeeTooHigh))
    );
    assert_eq!(w.env.config()?.kind_fee_bps, [0; 4]);
    Ok(())
}

#[test]
fn economics_still_refuses_a_swap_fee_above_one_percent() -> TestResult {
    let mut w = world()?;
    assert_eq!(MAX_FEE_BPS, 100);
    for kind_fee_bps in [
        [MAX_FEE_BPS + 1, 0, 0, 0],
        [0, MAX_FEE_BPS + 1, 0, 0],
        [0, 0, MAX_FEE_BPS + 1, 0],
        [MAX_ATTESTED_FEE_BPS, 0, 0, 0],
    ] {
        assert_eq!(
            w.set(Economics {
                kind_fee_mask: 0b1_1110,
                kind_fee_bps,
                ..economics(0, 0)
            })
            .err(),
            Some(engine_error(EngineError::FeeTooHigh)),
            "{kind_fee_bps:?}"
        );
    }
    let admin = w.env.authority.insecure_clone();
    let mut settings = w.env.settings();
    settings.fee_bps = MAX_FEE_BPS + 1;
    let ix = w.env.update_config_ix(&admin.pubkey(), settings);
    assert_eq!(
        w.env.send(&admin, &[ix], &[]).err(),
        Some(engine_error(EngineError::FeeTooHigh))
    );
    Ok(())
}

fn proof_message(
    w: &World,
    attestor: &Keypair,
    payee: &Pubkey,
    result: u64,
    spec_hash: [u8; 32],
    max_fee_bps: u16,
) -> [u8; intent_core::sig::ENVELOPE_LEN] {
    let preimage = intent_core::sig::AttestedProof {
        program: intent_engine::ID.to_bytes(),
        domain: DOMAIN,
        intent: intent_pda(&w.owner(), 0).to_bytes(),
        payee: payee.to_bytes(),
        amount_in: LARGE,
        result,
        filled: 0,
        revision: 0,
        max_fee_bps,
        ext_hash: empty_ext_hash(),
        spec_hash,
    }
    .preimage();
    let digest = solana_sha256_hasher::hashv(&[&preimage]).to_bytes();
    intent_core::sig::offchain_envelope(&attestor.pubkey().to_bytes(), &digest)
}

#[test]
fn a_proof_escrow_settles_at_a_three_percent_fee() -> TestResult {
    const SPEC: [u8; 32] = [0x3c; 32];
    const JUDGE_FEE: u64 = 1_000;
    let mut w = world()?;
    w.set(attested_fee(MAX_ATTESTED_FEE_BPS))?;
    let attestor = Keypair::new();
    let spec = IntentSpec {
        params: attested_result::Params {
            amount_in: LARGE,
            min_result: 1,
            max_result: 9,
            attestor: attestor.pubkey().to_bytes(),
            spec_hash: SPEC,
            judge_fee: JUDGE_FEE,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ..spec_with(0, Kind::AttestedResult, Vec::new(), &attestor.pubkey())?
    };
    w.create_spec(&spec)?;
    let judge_to = w.env.create_ata(
        &attestor.pubkey(),
        &w.market.input_mint,
        w.market.input_program,
    )?;
    w.env.judge_to = Some(judge_to);
    let payee = w.solver.input;
    let solver = w.solver.key.pubkey();
    let fill = |w: &mut World, bound: u16| {
        w.env.max_fee_bps = bound;
        let message = proof_message(w, &attestor, &payee, 5, SPEC, bound);
        let ix = w.env.fill_attested_ix(
            &solver,
            &w.owner(),
            &w.market,
            0,
            &payee,
            Some(&w.fee_to),
            5,
        );
        w.as_solver(&[ed25519_ix(&attestor, &message), ix])
    };
    assert_eq!(
        fill(&mut w, MAX_ATTESTED_FEE_BPS - 1).err(),
        Some(engine_error_at(1, EngineError::FeeAboveBound))
    );
    let fee_before = w.env.balance(&w.fee_to)?;
    let payee_before = w.env.balance(&payee)?;
    let meta = fill(&mut w, MAX_ATTESTED_FEE_BPS)?;
    let fees = intent_core::fee::split_fees(LARGE - JUDGE_FEE, MAX_ATTESTED_FEE_BPS, 0, 0)
        .map_err(|e| format!("{e:?}"))?;
    assert_eq!((fees.protocol, fees.net), (2_970, 96_030));
    let e = events::<IntentAttested>(&meta).pop().ok_or("missing")?;
    assert_eq!((e.fee, e.partner_fee, e.net), (2_970, 0, 96_030));
    assert_eq!(w.env.balance(&w.fee_to)?, fee_before + 2_970);
    assert_eq!(w.env.balance(&payee)?, payee_before + 96_030);
    assert_eq!(w.env.balance(&judge_to)?, JUDGE_FEE);
    assert_eq!(w.env.balance(&vault_pda(&intent_pda(&w.owner(), 0)))?, 0);
    Ok(())
}
