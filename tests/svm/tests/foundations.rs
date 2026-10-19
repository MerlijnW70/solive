use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use intent_core::kinds::{attested_result, limit_order, Kind};
use intent_engine::errors::EngineError;
use intent_engine::events::{
    ConfigUpdated, EpochAdvanced, FillBegun, IntentAttested, IntentFilled,
};
use intent_engine::ConfigUpdate;
use litesvm::types::TransactionMetadata;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    anchor_error, attestation_message, canonical_refund, config_pda, ed25519_ix, engine_error,
    engine_error_at, events, intent_pda, swap_spec, user_pda, Env, IntentSpec, Market, Solver,
    TestResult, Trader, DOMAIN, START_TS,
};

const PROGRAM: Pubkey = anchor_spl::token::ID;
const FUNDED: u64 = 4_000;
const ESCROW: u64 = 400;
const SUBMIT_BY: i64 = START_TS + 600;
const SWAP: u64 = 0;
const ATTESTED: u64 = 1;
const CONFIG_VERSION_AT: usize = 8 + 139;
const USER_VERSION_AT: usize = 8 + 72;
const INTENT_VERSION_AT: usize = 8 + 164;
const USER_EPOCH_AT: usize = 8 + 80;

struct World {
    env: Env,
    market: Market,
    trader: Trader,
    solver: Solver,
    attestor: Keypair,
    fee_to: Pubkey,
}

fn attested_spec(nonce: u64, attestor: &Pubkey) -> TestResult<IntentSpec> {
    Ok(IntentSpec {
        nonce,
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: ESCROW,
            min_result: 10,
            max_result: 20,
            attestor: attestor.to_bytes(),
            spec_hash: [0; 32],
            judge_fee: 0,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        expires_at: START_TS + 3_600,
        flags: 0,
        ext: Vec::new(),
    })
}

fn limit_spec(nonce: u64) -> TestResult<IntentSpec> {
    Ok(IntentSpec {
        nonce,
        kind: Kind::LimitOrder as u8,
        params: limit_order::Params {
            make_amount: ESCROW,
            take_amount: 10,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        expires_at: START_TS + 3_600,
        flags: 0,
        ext: Vec::new(),
    })
}

fn world() -> TestResult<World> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(PROGRAM, &[], PROGRAM, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let solver = env.solver(&market, 10_000)?;
    let fee_to = env.fee_account(&market)?;
    let attestor = Keypair::new();
    env.create_intent(&trader, &market, &swap_spec(SWAP, ESCROW)?)?;
    env.create_intent(
        &trader,
        &market,
        &attested_spec(ATTESTED, &attestor.pubkey())?,
    )?;
    Ok(World {
        env,
        market,
        trader,
        solver,
        attestor,
        fee_to,
    })
}

impl World {
    fn owner(&self) -> Pubkey {
        self.trader.key.pubkey()
    }

    fn solver_key(&self) -> Keypair {
        self.solver.key.insecure_clone()
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

    fn begin_ix(&self, nonce: u64) -> Instruction {
        self.env.begin_fill_ix(
            &self.solver.key.pubkey(),
            &self.owner(),
            &self.market,
            nonce,
            &self.solver.input,
            Some(&self.fee_to),
            1,
        )
    }

    fn end_ix(&self, nonce: u64) -> Instruction {
        self.env.end_fill_ix(
            &self.solver.key.pubkey(),
            &self.owner(),
            &self.market,
            nonce,
            &self.trader.receiver,
            &self.solver.output,
            ESCROW,
        )
    }

    fn attested_ixs(&self) -> [Instruction; 2] {
        let payee = self.solver.input;
        let message = attestation_message(
            DOMAIN,
            &self.attestor.pubkey(),
            &intent_pda(&self.owner(), ATTESTED),
            &payee,
            ESCROW,
            15,
        );
        [
            ed25519_ix(&self.attestor, &message),
            self.env.fill_attested_ix(
                &self.solver.key.pubkey(),
                &self.owner(),
                &self.market,
                ATTESTED,
                &payee,
                Some(&self.fee_to),
                15,
            ),
        ]
    }

    fn cancel_ix(&self, nonce: u64) -> Instruction {
        self.env
            .cancel_ix(&self.owner(), &self.market, nonce, &self.trader.input)
    }

    fn expire_ix(&self, nonce: u64) -> Instruction {
        self.env.expire_ix(
            &self.solver.key.pubkey(),
            &self.owner(),
            &self.market,
            nonce,
            &canonical_refund(&self.owner(), &self.market),
        )
    }

    fn close_ix(&self, nonce: u64) -> Instruction {
        self.env.close_ix_by(
            &self.solver.key.pubkey(),
            &self.owner(),
            &self.market,
            nonce,
            &self.trader.input,
        )
    }

    fn as_solver(&mut self, ixs: &[Instruction]) -> Result<TransactionMetadata, TransactionError> {
        let solver = self.solver_key();
        self.env.send(&solver, ixs, &[])
    }

    fn as_owner(&mut self, ixs: &[Instruction]) -> Result<TransactionMetadata, TransactionError> {
        let owner = self.trader.key.insecure_clone();
        self.env.send(&owner, ixs, &[])
    }

    fn as_admin(&mut self, ixs: &[Instruction]) -> Result<TransactionMetadata, TransactionError> {
        let admin = self.env.authority.insecure_clone();
        self.env.send(&admin, ixs, &[])
    }

    fn disable_fills(&mut self, mask: u64) -> Result<TransactionMetadata, TransactionError> {
        let s = self.env.settings();
        let ix = self.env.update_ix(
            &self.env.authority.pubkey(),
            ConfigUpdate {
                guardian: s.guardian,
                fee_recipient: s.fee_recipient,
                enabled_kinds: s.enabled_kinds,
                fee_bps: s.fee_bps,
                fill_disabled_kinds: mask,
            },
        );
        self.as_admin(&[ix])
    }

    fn poke(&mut self, key: &Pubkey, at: usize, bytes: &[u8]) -> TestResult {
        let mut account = self.env.svm.get_account(key).ok_or("account missing")?;
        let end = at.checked_add(bytes.len()).ok_or("overflow")?;
        account
            .data
            .get_mut(at..end)
            .ok_or("account too short")?
            .copy_from_slice(bytes);
        self.env.svm.set_account(*key, account)?;
        Ok(())
    }
}

fn amount_in_of(ix: &Instruction) -> TestResult<u64> {
    let bytes = ix.data.get(8..16).ok_or("short")?;
    Ok(u64::from_le_bytes(bytes.try_into()?))
}

#[test]
fn every_fill_path_takes_exactly_the_remaining_escrow() -> TestResult {
    for amount_in in [ESCROW - 1, ESCROW + 1, 0, u64::MAX] {
        let mut w = world()?;
        w.env.amount_in = Some(amount_in);
        let fill = w.fill_ix(SWAP);
        let flash = [w.begin_ix(SWAP), w.end_ix(SWAP)];
        let attested = w.attested_ixs();
        assert_eq!(
            w.as_solver(&[fill]).err(),
            Some(engine_error(EngineError::AmountInMismatch))
        );
        assert_eq!(
            w.as_solver(&flash).err(),
            Some(engine_error(EngineError::AmountInMismatch))
        );
        assert_eq!(
            w.as_solver(&attested).err(),
            Some(engine_error_at(1, EngineError::AmountInMismatch))
        );
        assert_eq!(w.env.intent(&w.owner(), SWAP)?.filled, 0);
        assert_eq!(w.env.intent(&w.owner(), ATTESTED)?.filled, 0);
    }
    Ok(())
}

#[test]
fn a_direct_fill_records_what_it_took() -> TestResult {
    let mut w = world()?;
    let ix = w.fill_ix(SWAP);
    assert_eq!(amount_in_of(&ix)?, ESCROW);
    let meta = w.as_solver(&[ix])?;
    let intent = w.env.intent(&w.owner(), SWAP)?;
    assert_eq!(intent.filled, ESCROW);
    assert_eq!(intent.revision, 1);
    assert_eq!(intent.in_flight, 0);
    let e = events::<IntentFilled>(&meta).pop().ok_or("missing")?;
    assert_eq!((e.amount_in, e.filled, e.remaining), (ESCROW, ESCROW, 0));
    Ok(())
}

#[test]
fn a_flash_fill_records_what_it_took() -> TestResult {
    let mut w = world()?;
    let flash = [w.begin_ix(SWAP), w.end_ix(SWAP)];
    let meta = w.as_solver(&flash)?;
    let intent = w.env.intent(&w.owner(), SWAP)?;
    assert_eq!(
        (intent.filled, intent.revision, intent.in_flight),
        (ESCROW, 1, 0)
    );
    let e = events::<FillBegun>(&meta).pop().ok_or("missing")?;
    assert_eq!((e.amount_in, e.filled, e.remaining), (ESCROW, ESCROW, 0));
    Ok(())
}

#[test]
fn an_attested_fill_records_what_it_took() -> TestResult {
    let mut w = world()?;
    let attested = w.attested_ixs();
    let meta = w.as_solver(&attested)?;
    let intent = w.env.intent(&w.owner(), ATTESTED)?;
    assert_eq!((intent.filled, intent.revision), (ESCROW, 1));
    let e = events::<IntentAttested>(&meta).pop().ok_or("missing")?;
    assert_eq!((e.amount_in, e.filled, e.remaining), (ESCROW, ESCROW, 0));
    Ok(())
}

#[test]
fn the_fill_kill_switch_stops_only_the_named_kinds() -> TestResult {
    let mut w = world()?;
    let trader = w.trader.key.insecure_clone();
    let mask = Kind::SwapExactIn.bit() | Kind::AttestedResult.bit();
    let meta = w.disable_fills(mask)?;
    assert_eq!(w.env.config()?.fill_disabled_kinds, mask);
    let e = events::<ConfigUpdated>(&meta).pop().ok_or("missing")?;
    assert_eq!(e.fill_disabled_kinds, mask);
    let fill = w.fill_ix(SWAP);
    let flash = [w.begin_ix(SWAP), w.end_ix(SWAP)];
    let attested = w.attested_ixs();
    assert_eq!(
        w.as_solver(&[fill]).err(),
        Some(engine_error(EngineError::FillKindDisabled))
    );
    assert_eq!(
        w.as_solver(&flash).err(),
        Some(engine_error(EngineError::FillKindDisabled))
    );
    assert_eq!(
        w.as_solver(&attested).err(),
        Some(engine_error_at(1, EngineError::FillKindDisabled))
    );
    w.env
        .create_intent(&w.trader, &w.market, &swap_spec(5, ESCROW)?)?;
    w.env.create_intent(&w.trader, &w.market, &limit_spec(6)?)?;
    let limit = w.fill_ix(6);
    w.as_solver(&[limit])?;
    let cancel = w.cancel_ix(SWAP);
    w.env.send(&trader, &[cancel], &[])?;
    w.disable_fills(0)?;
    let fill = w.fill_ix(5);
    w.as_solver(&[fill])?;
    Ok(())
}

#[test]
fn the_fill_kill_switch_refuses_unknown_kind_bits() -> TestResult {
    let mut w = world()?;
    for mask in [1u64 << 40, u64::MAX] {
        assert_eq!(
            w.disable_fills(mask).err(),
            Some(engine_error(EngineError::UnknownKindBits))
        );
    }
    assert_eq!(w.env.config()?.fill_disabled_kinds, 0);
    Ok(())
}

fn config_cases(w: &mut World, pending: &Keypair) -> TestResult<Vec<(Keypair, Vec<Instruction>)>> {
    let admin = w.env.authority.pubkey();
    let settings = w.env.settings();
    let guardian = w.env.guardian.insecure_clone();
    let payer = w.env.funded()?;
    Ok(vec![
        (
            w.env.authority.insecure_clone(),
            vec![w.env.update_config_ix(&admin, settings)],
        ),
        (
            w.env.authority.insecure_clone(),
            vec![w.env.economics_ix(
                &admin,
                intent_engine::Economics {
                    kind_fee_mask: 0,
                    kind_fee_bps: [0; 4],
                    partner_cut_bps: 0,
                    crank_bounty: 1,
                    create_fee: 1,
                },
            )],
        ),
        (
            w.env.authority.insecure_clone(),
            vec![w.env.propose_admin_ix(&admin, pending.pubkey())],
        ),
        (
            pending.insecure_clone(),
            vec![w.env.accept_admin_ix(&pending.pubkey())],
        ),
        (
            guardian.insecure_clone(),
            vec![w.env.raise_pause_ix(&guardian.pubkey(), 1)],
        ),
        (
            w.env.authority.insecure_clone(),
            vec![w.env.lower_pause_ix(&admin, 1)],
        ),
        (
            w.trader.key.insecure_clone(),
            vec![w
                .env
                .create_intent_ix(&w.trader, &w.market, &swap_spec(9, ESCROW)?)],
        ),
        (
            payer.insecure_clone(),
            vec![w.env.create_signed_ix(
                &payer.pubkey(),
                &w.trader,
                &w.market,
                &swap_spec(9, ESCROW)?,
                SUBMIT_BY,
            )],
        ),
        (w.solver_key(), vec![w.fill_ix(SWAP)]),
        (w.solver_key(), vec![w.begin_ix(SWAP), w.end_ix(SWAP)]),
        (
            w.solver_key(),
            vec![w.env.fill_attested_ix(
                &w.solver.key.pubkey(),
                &w.owner(),
                &w.market,
                ATTESTED,
                &w.solver.input,
                Some(&w.fee_to),
                15,
            )],
        ),
    ])
}

fn proposed(w: &mut World) -> TestResult<Keypair> {
    let pending = w.env.funded()?;
    let admin = w.env.authority.pubkey();
    let propose = w.env.propose_admin_ix(&admin, pending.pubkey());
    w.as_admin(&[propose])?;
    Ok(pending)
}

#[test]
fn every_load_refuses_an_unknown_config_version() -> TestResult {
    for version in [0u8, 1, 3, u8::MAX] {
        let mut w = world()?;
        let pending = proposed(&mut w)?;
        w.poke(&config_pda(), CONFIG_VERSION_AT, &[version])?;
        let cases = config_cases(&mut w, &pending)?;
        for (i, (signer, ixs)) in cases.iter().enumerate() {
            assert_eq!(
                w.env.send(signer, ixs, &[]).err(),
                Some(engine_error(EngineError::AccountOutdated)),
                "version {version} case {i}"
            );
        }
    }
    Ok(())
}

#[test]
fn a_config_copied_to_any_other_address_is_refused() -> TestResult {
    let mut w = world()?;
    let pending = proposed(&mut w)?;
    let mut copy = w
        .env
        .svm
        .get_account(&config_pda())
        .ok_or("config missing")?;
    if let Some(fee) = copy.data.get_mut(8 + 136..8 + 138) {
        fee.copy_from_slice(&0u16.to_le_bytes());
    }
    let fake = Pubkey::new_unique();
    w.env.svm.set_account(fake, copy)?;
    let cases = config_cases(&mut w, &pending)?;
    for (i, (signer, mut ixs)) in cases.into_iter().enumerate() {
        for ix in &mut ixs {
            for meta in &mut ix.accounts {
                if meta.pubkey == config_pda() {
                    meta.pubkey = fake;
                }
            }
        }
        let err = w.env.send(&signer, &ixs, &[]).err();
        assert!(
            matches!(
                err,
                Some(TransactionError::InstructionError(
                    _,
                    solana_instruction_error::InstructionError::Custom(code)
                )) if code == u32::from(ErrorCode::ConstraintAddress)
            ),
            "case {i}: {err:?}"
        );
    }
    let cases = config_cases(&mut w, &pending)?;
    for (i, (signer, ixs)) in cases.iter().enumerate().take(5) {
        w.env
            .send(signer, ixs, &[])
            .map_err(|e| format!("case {i}: {e:?}"))?;
    }
    Ok(())
}

#[test]
fn every_load_refuses_an_unknown_user_version() -> TestResult {
    for version in [0u8, 1, 3, u8::MAX] {
        let mut w = world()?;
        let owner = w.owner();
        w.poke(&user_pda(&owner), USER_VERSION_AT, &[version])?;
        let payer = w.env.funded()?;
        let cases: Vec<(Keypair, Instruction)> = vec![
            (w.trader.key.insecure_clone(), w.env.advance_ix(&owner, 5)),
            (
                w.trader.key.insecure_clone(),
                w.env.advance_epoch_ix(&owner, 1),
            ),
            (
                w.trader.key.insecure_clone(),
                w.env
                    .create_intent_ix(&w.trader, &w.market, &swap_spec(9, ESCROW)?),
            ),
            (
                payer.insecure_clone(),
                w.env.create_signed_ix(
                    &payer.pubkey(),
                    &w.trader,
                    &w.market,
                    &swap_spec(9, ESCROW)?,
                    SUBMIT_BY,
                ),
            ),
        ];
        for (i, (signer, ix)) in cases.iter().enumerate() {
            assert_eq!(
                w.env.send(signer, std::slice::from_ref(ix), &[]).err(),
                Some(engine_error(EngineError::AccountOutdated)),
                "version {version} case {i}"
            );
        }
    }
    Ok(())
}

#[test]
fn every_load_refuses_an_unknown_intent_version() -> TestResult {
    for version in [0u8, 1, 3, u8::MAX] {
        let mut w = world()?;
        let owner = w.owner();
        for nonce in [SWAP, ATTESTED] {
            w.poke(&intent_pda(&owner, nonce), INTENT_VERSION_AT, &[version])?;
        }
        let cases: Vec<(Keypair, Vec<Instruction>)> = vec![
            (w.solver_key(), vec![w.fill_ix(SWAP)]),
            (w.solver_key(), vec![w.begin_ix(SWAP), w.end_ix(SWAP)]),
            (w.solver_key(), vec![w.end_ix(SWAP)]),
            (
                w.solver_key(),
                vec![w.env.fill_attested_ix(
                    &w.solver.key.pubkey(),
                    &owner,
                    &w.market,
                    ATTESTED,
                    &w.solver.input,
                    Some(&w.fee_to),
                    15,
                )],
            ),
            (w.trader.key.insecure_clone(), vec![w.cancel_ix(SWAP)]),
            (w.solver_key(), vec![w.expire_ix(SWAP)]),
            (w.solver_key(), vec![w.close_ix(SWAP)]),
        ];
        let refunds_too = !intent_engine::state::intent_readable(version);
        let checked = if refunds_too { cases.len() } else { 4 };
        for (i, (signer, ixs)) in cases.iter().enumerate().take(checked) {
            assert_eq!(
                w.env.send(signer, ixs, &[]).err(),
                Some(engine_error(EngineError::AccountOutdated)),
                "version {version} case {i}"
            );
        }
    }
    Ok(())
}

#[test]
fn advancing_the_epoch_voids_every_outstanding_signature() -> TestResult {
    let mut w = world()?;
    let owner = w.owner();
    let relayer = w.env.funded()?;
    w.env.approve_delegate(&w.trader, &w.market, ESCROW)?;
    let spec = swap_spec(9, ESCROW)?;
    let stale = w
        .env
        .signed_message(&w.trader, &w.market, &spec, DOMAIN, SUBMIT_BY);
    let jump = 0x5eed_0000_0001;
    let ix = w.env.advance_epoch_ix(&owner, jump);
    let meta = w.as_owner(&[ix])?;
    assert_eq!(w.env.user(&owner)?.epoch, jump);
    let e = events::<EpochAdvanced>(&meta).pop().ok_or("missing")?;
    assert_eq!((e.owner, e.epoch), (owner, jump));
    let create = w
        .env
        .create_signed_ix(&relayer.pubkey(), &w.trader, &w.market, &spec, SUBMIT_BY);
    assert_eq!(
        w.env
            .send(
                &relayer,
                &[ed25519_ix(&w.trader.key, &stale), create.clone()],
                &[]
            )
            .err(),
        Some(engine_error_at(1, EngineError::SigMessage))
    );
    let fresh = w
        .env
        .signed_message(&w.trader, &w.market, &spec, DOMAIN, SUBMIT_BY);
    assert_ne!(fresh, stale);
    w.env
        .send(&relayer, &[ed25519_ix(&w.trader.key, &fresh), create], &[])?;
    let ix = w.env.advance_epoch_ix(&owner, jump + 1);
    w.as_owner(&[ix])?;
    assert_eq!(w.env.user(&owner)?.epoch, jump + 1);
    Ok(())
}

#[test]
fn a_signature_for_a_future_epoch_is_not_armed_by_a_revocation() -> TestResult {
    let mut w = world()?;
    let owner = w.owner();
    let relayer = w.env.funded()?;
    w.env.approve_delegate(&w.trader, &w.market, ESCROW)?;
    let spec = swap_spec(9, ESCROW)?;
    let armed = w
        .env
        .signed_message_at(&w.trader, &w.market, &spec, DOMAIN, SUBMIT_BY, 1);
    let ix = w.env.advance_epoch_ix(&owner, 0x0bad_c0de);
    w.as_owner(&[ix])?;
    let create = w
        .env
        .create_signed_ix(&relayer.pubkey(), &w.trader, &w.market, &spec, SUBMIT_BY);
    assert_eq!(
        w.env
            .send(&relayer, &[ed25519_ix(&w.trader.key, &armed), create], &[])
            .err(),
        Some(engine_error_at(1, EngineError::SigMessage))
    );
    Ok(())
}

#[test]
fn only_the_owner_advances_their_epoch_and_only_upwards() -> TestResult {
    let mut w = world()?;
    let owner = w.owner();
    let stranger = w.env.funded()?;
    let mut ix = w.env.advance_epoch_ix(&stranger.pubkey(), 1);
    if let Some(meta) = ix.accounts.get_mut(1) {
        meta.pubkey = user_pda(&owner);
    }
    assert_eq!(
        w.env.send(&stranger, &[ix], &[]).err(),
        Some(anchor_error(ErrorCode::ConstraintSeeds))
    );
    assert_eq!(w.env.user(&owner)?.epoch, 0);
    for epoch in [0, 7] {
        let ix = w.env.advance_epoch_ix(&owner, epoch);
        if epoch == 0 {
            assert_eq!(
                w.as_owner(&[ix]).err(),
                Some(engine_error(EngineError::EpochRegression))
            );
        } else {
            w.as_owner(&[ix])?;
        }
    }
    for epoch in [0, 6, 7] {
        let ix = w.env.advance_epoch_ix(&owner, epoch);
        assert_eq!(
            w.as_owner(&[ix]).err(),
            Some(engine_error(EngineError::EpochRegression)),
            "{epoch}"
        );
    }
    assert_eq!(w.env.user(&owner)?.epoch, 7);
    w.poke(&user_pda(&owner), USER_EPOCH_AT, &u64::MAX.to_le_bytes())?;
    let ix = w.env.advance_epoch_ix(&owner, u64::MAX);
    assert_eq!(
        w.as_owner(&[ix]).err(),
        Some(engine_error(EngineError::EpochRegression))
    );
    assert_eq!(w.env.user(&owner)?.epoch, u64::MAX);
    Ok(())
}

#[test]
fn unknown_flags_are_refused_on_both_create_paths() -> TestResult {
    for flags in [1u16, 0x8000, u16::MAX] {
        let mut w = world()?;
        let relayer = w.env.funded()?;
        w.env.approve_delegate(&w.trader, &w.market, ESCROW)?;
        let mut spec = swap_spec(9, ESCROW)?;
        spec.flags = flags;
        let create = w.env.create_intent_ix(&w.trader, &w.market, &spec);
        assert_eq!(
            w.as_owner(&[create]).err(),
            Some(engine_error(EngineError::FlagsUnknown))
        );
        let message = w
            .env
            .signed_message(&w.trader, &w.market, &spec, DOMAIN, SUBMIT_BY);
        let signed =
            w.env
                .create_signed_ix(&relayer.pubkey(), &w.trader, &w.market, &spec, SUBMIT_BY);
        assert_eq!(
            w.env
                .send(
                    &relayer,
                    &[ed25519_ix(&w.trader.key, &message), signed],
                    &[]
                )
                .err(),
            Some(engine_error_at(1, EngineError::FlagsUnknown))
        );
        assert!(w.env.intent(&w.owner(), 9).is_err());
    }
    Ok(())
}

#[test]
fn extension_bytes_are_refused_until_a_tag_is_defined() -> TestResult {
    let cases: [(&[u8], EngineError); 4] = [
        (&[2, 0, 0], EngineError::ExtUnknown),
        (&[0, 0, 0], EngineError::ExtMalformed),
        (&[1, 5, 0], EngineError::ExtMalformed),
        (&[7], EngineError::ExtMalformed),
    ];
    for (ext, expected) in cases {
        let mut w = world()?;
        let relayer = w.env.funded()?;
        w.env.approve_delegate(&w.trader, &w.market, ESCROW)?;
        let mut spec = swap_spec(9, ESCROW)?;
        spec.ext = ext.to_vec();
        let create = w.env.create_intent_ix(&w.trader, &w.market, &spec);
        assert_eq!(w.as_owner(&[create]).err(), Some(engine_error(expected)));
        let message = w
            .env
            .signed_message(&w.trader, &w.market, &spec, DOMAIN, SUBMIT_BY);
        let signed =
            w.env
                .create_signed_ix(&relayer.pubkey(), &w.trader, &w.market, &spec, SUBMIT_BY);
        assert_eq!(
            w.env
                .send(
                    &relayer,
                    &[ed25519_ix(&w.trader.key, &message), signed],
                    &[]
                )
                .err(),
            Some(engine_error_at(1, expected))
        );
        let clean_begin = w.begin_ix(SWAP);
        w.env.ext = ext.to_vec();
        let solver_cases: [(Vec<Instruction>, u8); 6] = [
            (vec![w.fill_ix(SWAP)], 0),
            (vec![w.begin_ix(SWAP), w.end_ix(SWAP)], 0),
            (vec![clean_begin, w.end_ix(SWAP)], 1),
            (w.attested_ixs().to_vec(), 1),
            (vec![w.expire_ix(SWAP)], 0),
            (vec![w.close_ix(SWAP)], 0),
        ];
        for (i, (ixs, at)) in solver_cases.iter().enumerate() {
            assert_eq!(
                w.as_solver(ixs).err(),
                Some(engine_error_at(*at, expected)),
                "{ext:?} case {i}"
            );
        }
        let cancel = w.cancel_ix(SWAP);
        assert_eq!(w.as_owner(&[cancel]).err(), Some(engine_error(expected)));
    }
    Ok(())
}

#[test]
fn extension_bytes_are_bounded_before_any_allocation() -> TestResult {
    let mut w = world()?;
    let mut at_limit = vec![1u8, 0xfd, 0x01];
    at_limit.resize(512, 0);
    w.env.ext = at_limit;
    let cancel = w.cancel_ix(SWAP);
    assert_eq!(
        w.as_owner(&[cancel]).err(),
        Some(engine_error(EngineError::ExtUnknown))
    );
    let mut over = vec![1u8, 0xfe, 0x01];
    over.resize(513, 0);
    w.env.ext = over;
    let cancel = w.cancel_ix(SWAP);
    assert_eq!(
        w.as_owner(&[cancel]).err(),
        Some(anchor_error(ErrorCode::InstructionDidNotDeserialize))
    );
    w.env.ext = Vec::new();
    for len in [513u32, 0x7a00, 1 << 20, u32::MAX] {
        let mut cancel = w.cancel_ix(SWAP);
        cancel
            .data
            .get_mut(8..12)
            .ok_or("short")?
            .copy_from_slice(&len.to_le_bytes());
        assert_eq!(
            w.as_owner(&[cancel]).err(),
            Some(anchor_error(ErrorCode::InstructionDidNotDeserialize)),
            "{len}"
        );
    }
    let cancel = w.cancel_ix(SWAP);
    w.as_owner(&[cancel])?;
    Ok(())
}

#[test]
fn creates_and_fills_tolerate_extra_trailing_accounts() -> TestResult {
    let mut w = world()?;
    let extra = AccountMeta::new_readonly(Pubkey::new_unique(), false);
    let mut create = w
        .env
        .create_intent_ix(&w.trader, &w.market, &swap_spec(9, ESCROW)?);
    create.accounts.push(extra.clone());
    w.as_owner(&[create])?;
    let mut fill = w.fill_ix(9);
    fill.accounts.push(extra.clone());
    w.as_solver(&[fill])?;
    let mut begin = w.begin_ix(SWAP);
    begin.accounts.push(extra.clone());
    let mut end = w.end_ix(SWAP);
    end.accounts.push(extra);
    w.as_solver(&[begin, end])?;
    assert_eq!(w.env.intent(&w.owner(), 9)?.filled, ESCROW);
    assert_eq!(w.env.intent(&w.owner(), SWAP)?.filled, ESCROW);
    Ok(())
}

#[test]
fn a_standalone_end_fill_without_a_begin_is_refused() -> TestResult {
    let mut w = world()?;
    assert_eq!(
        w.as_solver(&[w.end_ix(SWAP)]).err(),
        Some(engine_error(EngineError::InvalidTransition)),
        "end_fill may only run on a Filling intent, never standalone"
    );
    let intent = w.env.intent(&w.owner(), SWAP)?;
    assert_eq!(
        (intent.status, intent.in_flight),
        (0, 0),
        "intent untouched"
    );
    Ok(())
}

#[test]
fn a_second_begin_cannot_double_pay_a_flash_filled_intent() -> TestResult {
    let mut w = world()?;
    let solver = w.solver.key.pubkey();
    let owner = w.owner();
    let first = w.env.begin_fill_ix(
        &solver,
        &owner,
        &w.market,
        SWAP,
        &w.solver.input,
        Some(&w.fee_to),
        2,
    );
    let second = w.env.begin_fill_ix(
        &solver,
        &owner,
        &w.market,
        SWAP,
        &w.solver.input,
        Some(&w.fee_to),
        3,
    );
    let end_a = w.end_ix(SWAP);
    let end_b = w.end_ix(SWAP);
    assert_eq!(
        w.as_solver(&[first, second, end_a, end_b]).err(),
        Some(engine_error_at(1, EngineError::InvalidTransition)),
        "a second begin on a Filling intent is rejected, even with its own end row"
    );

    let flash = [w.begin_ix(SWAP), w.end_ix(SWAP)];
    w.as_solver(&flash)?;
    let settled = w.env.intent(&owner, SWAP)?;
    assert_eq!(
        (settled.status, settled.filled, settled.in_flight),
        (1, ESCROW, 0)
    );
    assert_eq!(
        w.as_solver(&[w.begin_ix(SWAP), w.end_ix(SWAP)]).err(),
        Some(engine_error(EngineError::InvalidTransition)),
        "a settled intent cannot be flash-filled again"
    );
    Ok(())
}
