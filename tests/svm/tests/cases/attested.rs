use anchor_lang::prelude::Pubkey;
use intent_core::kinds::{attested_result, Kind};
use intent_core::lifecycle::Status;
use intent_engine::errors::EngineError;
use intent_engine::events::IntentAttested;
use intent_engine::state::PAUSE_FILL;
use litesvm::types::TransactionMetadata;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    bump_search_cost,
    attestation_envelope, attestation_message, empty_ext_hash, Attestation, cu_gate, ed25519_ix, engine_error, engine_error_at, events, intent_pda,
    swap_spec, token_transfers, vault_pda, Env, IntentSpec, Market, Solver, TestResult, Trader,
    DOMAIN, START_TS,
};

const FUNDED: u64 = 1_000;
const ESCROW: u64 = 400;

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
        expires_at: START_TS.saturating_add(3_600),
        flags: 0,
        ext: Vec::new(),
    })
}

fn world() -> TestResult<World> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(PROGRAM, &[], PROGRAM, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let solver = env.solver(&market, 0)?;
    let fee_to = env.fee_account(&market)?;
    let attestor = Keypair::new();
    env.create_intent(&trader, &market, &attested_spec(0, &attestor.pubkey())?)?;
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

    fn attestation(&self, nonce: u64, payee: &Pubkey, result: u64) -> Vec<u8> {
        attestation_envelope(
            &self.attestor.pubkey(),
            &Attestation {
                domain: DOMAIN,
                intent: intent_pda(&self.owner(), nonce),
                payee: *payee,
                amount_in: ESCROW,
                result,
                filled: 0,
                revision: 0,
                max_fee_bps: self.env.max_fee_bps,
                ext_hash: empty_ext_hash(),
            },
        )
        .to_vec()
    }

    fn fill(
        &mut self,
        signer: &Keypair,
        nonce: u64,
        signed_payee: &Pubkey,
        signed_result: u64,
        payee: &Pubkey,
        result: u64,
    ) -> Result<TransactionMetadata, TransactionError> {
        let message = self.attestation(nonce, signed_payee, signed_result);
        let fill = self.env.fill_attested_ix(
            &self.solver.key.pubkey(),
            &self.owner(),
            &self.market,
            nonce,
            payee,
            Some(&self.fee_to),
            result,
        );
        let solver = self.solver.key.insecure_clone();
        self.env
            .send(&solver, &[ed25519_ix(signer, &message), fill], &[])
    }
}

#[test]
fn an_attested_result_releases_escrow_to_the_named_payee() -> TestResult {
    let mut w = world()?;
    let attestor = w.attestor.insecure_clone();
    let payee = w.solver.input;
    let meta = w.fill(&attestor, 0, &payee, 15, &payee, 15)?;
    assert_eq!(w.env.balance(&payee)?, ESCROW - 1);
    assert_eq!(w.env.balance(&w.fee_to)?, 1);
    assert_eq!(w.env.balance(&vault_pda(&intent_pda(&w.owner(), 0)))?, 0);
    assert_eq!(w.env.intent(&w.owner(), 0)?.status, Status::Filled as u8);
    assert_eq!(token_transfers(&meta), 2);
    let e = events::<IntentAttested>(&meta).pop().ok_or("missing")?;
    assert_eq!(e.intent, intent_pda(&w.owner(), 0));
    assert_eq!(e.owner, w.owner());
    assert_eq!(e.solver, w.solver.key.pubkey());
    assert_eq!(e.payee, payee);
    assert_eq!(e.attestor, attestor.pubkey());
    assert_eq!(
        (e.amount_in, e.result, e.fee, e.net),
        (ESCROW, 15, 1, ESCROW - 1)
    );
    Ok(())
}

#[test]
fn an_attestation_holds_only_for_the_fee_bound_its_attestor_signed() -> TestResult {
    let mut w = world()?;
    let attestor = w.attestor.insecure_clone();
    let payee = w.solver.input;
    let intent = intent_pda(&w.owner(), 0);
    let message = attestation_envelope(
        &attestor.pubkey(),
        &Attestation {
            domain: DOMAIN,
            intent,
            payee,
            amount_in: ESCROW,
            result: 15,
            filled: 0,
            revision: 0,
            max_fee_bps: 5,
            ext_hash: empty_ext_hash(),
        },
    );
    let solver = w.solver.key.insecure_clone();
    for (bound, refused) in [(u16::MAX, true), (6, true), (5, false)] {
        w.env.max_fee_bps = bound;
        let fill = w.env.fill_attested_ix(
            &w.solver.key.pubkey(),
            &w.owner(),
            &w.market,
            0,
            &payee,
            Some(&w.fee_to),
            15,
        );
        let sent = w
            .env
            .send(&solver, &[ed25519_ix(&attestor, &message), fill], &[]);
        if refused {
            assert_eq!(
                sent.err(),
                Some(engine_error_at(1, EngineError::SigMessage)),
                "bound {bound}"
            );
        } else {
            sent?;
        }
    }
    Ok(())
}

#[test]
fn an_attested_fill_rechecks_the_input_mint_against_policy() -> TestResult {
    if PROGRAM != anchor_spl::token_2022::ID {
        return Ok(());
    }
    let mut w = world()?;
    let hooked = w
        .env
        .create_mint(PROGRAM, &[svm_tests::MintExt::TransferHook])?;
    let forged = w.env.svm.get_account(&hooked).ok_or("mint missing")?;
    w.env.svm.set_account(w.market.input_mint, forged)?;
    let attestor = w.attestor.insecure_clone();
    let payee = w.solver.input;
    assert_eq!(
        w.fill(&attestor, 0, &payee, 15, &payee, 15).err(),
        Some(engine_error_at(1, EngineError::MintNotAllowed))
    );
    Ok(())
}

#[test]
fn an_attested_fill_refuses_an_intent_carrying_an_agent_fee() -> TestResult {
    const AGENT_FEE: core::ops::Range<usize> = 440..448;
    let mut w = world()?;
    let intent = intent_pda(&w.owner(), 0);
    let mut account = w.env.svm.get_account(&intent).ok_or("intent missing")?;
    account
        .data
        .get_mut(AGENT_FEE)
        .ok_or("intent too short")?
        .copy_from_slice(&1u64.to_le_bytes());
    w.env.svm.set_account(intent, account)?;
    assert_eq!(w.env.intent(&w.owner(), 0)?.agent_fee, 1);
    let attestor = w.attestor.insecure_clone();
    let payee = w.solver.input;
    assert_eq!(
        w.fill(&attestor, 0, &payee, 15, &payee, 15).err(),
        Some(engine_error_at(1, EngineError::MandateMismatch))
    );
    Ok(())
}

#[test]
fn results_on_both_bounds_are_accepted() -> TestResult {
    for result in [10, 20] {
        let mut w = world()?;
        let attestor = w.attestor.insecure_clone();
        let payee = w.solver.input;
        w.fill(&attestor, 0, &payee, result, &payee, result)?;
        assert_eq!(w.env.balance(&payee)?, ESCROW - 1, "{result}");
    }
    Ok(())
}

#[test]
fn results_outside_the_signed_bounds_are_rejected() -> TestResult {
    let mut w = world()?;
    let attestor = w.attestor.insecure_clone();
    let payee = w.solver.input;
    for result in [9, 21] {
        assert_eq!(
            w.fill(&attestor, 0, &payee, result, &payee, result).err(),
            Some(engine_error_at(1, EngineError::ResultOutOfBounds)),
            "{result}"
        );
    }
    Ok(())
}

#[test]
fn only_the_intents_attestor_can_attest() -> TestResult {
    let mut w = world()?;
    let impostor = Keypair::new();
    let payee = w.solver.input;
    assert_eq!(
        w.fill(&impostor, 0, &payee, 15, &payee, 15).err(),
        Some(engine_error_at(1, EngineError::SigPubkey))
    );
    Ok(())
}

#[test]
fn a_public_attestation_cannot_be_redirected_or_reread() -> TestResult {
    let mut w = world()?;
    let attestor = w.attestor.insecure_clone();
    let payee = w.solver.input;
    let thief = w.env.create_token_account(
        &w.market.input_mint,
        &Pubkey::new_unique(),
        w.market.input_program,
    )?;
    assert_eq!(
        w.fill(&attestor, 0, &payee, 15, &thief, 15).err(),
        Some(engine_error_at(1, EngineError::SigMessage))
    );
    assert_eq!(
        w.fill(&attestor, 0, &payee, 15, &payee, 16).err(),
        Some(engine_error_at(1, EngineError::SigMessage))
    );
    assert_eq!(w.env.balance(&thief)?, 0);
    Ok(())
}

#[test]
fn an_attestation_for_another_intent_is_rejected() -> TestResult {
    let mut w = world()?;
    let attestor = w.attestor.insecure_clone();
    let spec = attested_spec(1, &attestor.pubkey())?;
    w.env.mint_to(
        &w.market.input_mint,
        &w.trader.input,
        w.market.input_program,
        ESCROW,
    )?;
    w.env.create_intent(&w.trader, &w.market, &spec)?;
    let payee = w.solver.input;
    let message = w.attestation(1, &payee, 15);
    let fill = w.env.fill_attested_ix(
        &w.solver.key.pubkey(),
        &w.owner(),
        &w.market,
        0,
        &payee,
        Some(&w.fee_to),
        15,
    );
    let solver = w.solver.key.insecure_clone();
    assert_eq!(
        w.env
            .send(&solver, &[ed25519_ix(&attestor, &message), fill], &[])
            .err(),
        Some(engine_error_at(1, EngineError::SigMessage))
    );
    Ok(())
}

#[test]
fn an_attested_fill_without_a_signature_is_rejected() -> TestResult {
    let mut w = world()?;
    let payee = w.solver.input;
    let fill = w.env.fill_attested_ix(
        &w.solver.key.pubkey(),
        &w.owner(),
        &w.market,
        0,
        &payee,
        Some(&w.fee_to),
        15,
    );
    let solver = w.solver.key.insecure_clone();
    assert_eq!(
        w.env.send(&solver, &[fill], &[]).err(),
        Some(engine_error(EngineError::SigMissing))
    );
    Ok(())
}

#[test]
fn an_attested_intent_fills_only_once_and_only_before_expiry() -> TestResult {
    let mut w = world()?;
    let attestor = w.attestor.insecure_clone();
    let payee = w.solver.input;
    w.fill(&attestor, 0, &payee, 15, &payee, 15)?;
    assert_eq!(
        w.fill(&attestor, 0, &payee, 15, &payee, 15).err(),
        Some(engine_error_at(1, EngineError::InvalidTransition))
    );
    let mut late = world()?;
    late.env.set_now(START_TS.saturating_add(3_600));
    let attestor = late.attestor.insecure_clone();
    let payee = late.solver.input;
    assert_eq!(
        late.fill(&attestor, 0, &payee, 15, &payee, 15).err(),
        Some(engine_error_at(1, EngineError::IntentExpired))
    );
    Ok(())
}

#[test]
fn fill_pause_blocks_attested_fills() -> TestResult {
    let mut w = world()?;
    let authority = w.env.authority.insecure_clone();
    let ix = w.env.raise_pause_ix(&authority.pubkey(), PAUSE_FILL);
    w.env.send(&authority, &[ix], &[])?;
    let attestor = w.attestor.insecure_clone();
    let payee = w.solver.input;
    assert_eq!(
        w.fill(&attestor, 0, &payee, 15, &payee, 15).err(),
        Some(engine_error_at(1, EngineError::FillPaused))
    );
    Ok(())
}

#[test]
fn zero_fee_needs_no_fee_account() -> TestResult {
    let mut w = world()?;
    let authority = w.env.authority.insecure_clone();
    let mut settings = w.env.settings();
    settings.fee_bps = 0;
    let ix = w.env.update_config_ix(&authority.pubkey(), settings);
    w.env.send(&authority, &[ix], &[])?;
    let attestor = w.attestor.insecure_clone();
    let payee = w.solver.input;
    let message = w.attestation(0, &payee, 15);
    let fill = w.env.fill_attested_ix(
        &w.solver.key.pubkey(),
        &w.owner(),
        &w.market,
        0,
        &payee,
        None,
        15,
    );
    let solver = w.solver.key.insecure_clone();
    let meta = w
        .env
        .send(&solver, &[ed25519_ix(&attestor, &message), fill], &[])?;
    assert_eq!(token_transfers(&meta), 1);
    assert_eq!(w.env.balance(&payee)?, ESCROW);
    Ok(())
}

#[test]
fn a_fee_without_a_fee_account_is_rejected() -> TestResult {
    let mut w = world()?;
    let attestor = w.attestor.insecure_clone();
    let payee = w.solver.input;
    let message = w.attestation(0, &payee, 15);
    let fill = w.env.fill_attested_ix(
        &w.solver.key.pubkey(),
        &w.owner(),
        &w.market,
        0,
        &payee,
        None,
        15,
    );
    let solver = w.solver.key.insecure_clone();
    assert_eq!(
        w.env
            .send(&solver, &[ed25519_ix(&attestor, &message), fill], &[])
            .err(),
        Some(engine_error_at(1, EngineError::FeeAccountMissing))
    );
    Ok(())
}

#[test]
fn kinds_settle_only_through_their_own_instruction() -> TestResult {
    let mut w = world()?;
    let fill = w.env.fill_ix(
        &w.solver,
        &w.owner(),
        &w.market,
        0,
        &w.trader.receiver,
        Some(&w.fee_to),
        1_000,
    );
    let solver = w.solver.key.insecure_clone();
    assert_eq!(
        w.env.send(&solver, &[fill], &[]).err(),
        Some(engine_error(EngineError::KindMismatch))
    );
    w.env.mint_to(
        &w.market.input_mint,
        &w.trader.input,
        w.market.input_program,
        ESCROW,
    )?;
    w.env
        .create_intent(&w.trader, &w.market, &swap_spec(5, ESCROW)?)?;
    let attestor = w.attestor.insecure_clone();
    let payee = w.solver.input;
    assert_eq!(
        w.fill(&attestor, 5, &payee, 15, &payee, 15).err(),
        Some(engine_error_at(1, EngineError::KindMismatch))
    );
    Ok(())
}

#[test]
fn an_attestation_from_another_cluster_amount_or_revision_is_rejected() -> TestResult {
    let mut w = world()?;
    let attestor = w.attestor.insecure_clone();
    let payee = w.solver.input;
    let intent = intent_pda(&w.owner(), 0);
    for message in [
        attestation_message([0x22; 32], &attestor.pubkey(), &intent, &payee, ESCROW, 15),
        attestation_message(DOMAIN, &attestor.pubkey(), &intent, &payee, ESCROW - 1, 15),
        attestation_envelope(
            &attestor.pubkey(),
            &Attestation {
                domain: DOMAIN,
                intent,
                payee,
                amount_in: ESCROW,
                result: 15,
                filled: 1,
                revision: 0,
                max_fee_bps: intent_engine::state::MAX_FEE_BPS,
                ext_hash: empty_ext_hash(),
            },
        ),
        attestation_envelope(
            &attestor.pubkey(),
            &Attestation {
                domain: DOMAIN,
                intent,
                payee,
                amount_in: ESCROW,
                result: 15,
                filled: 0,
                revision: 1,
                max_fee_bps: intent_engine::state::MAX_FEE_BPS,
                ext_hash: empty_ext_hash(),
            },
        ),
        attestation_envelope(
            &attestor.pubkey(),
            &Attestation {
                domain: DOMAIN,
                intent,
                payee,
                amount_in: ESCROW,
                result: 15,
                filled: 0,
                revision: 0,
                max_fee_bps: intent_engine::state::MAX_FEE_BPS,
                ext_hash: [9; 32],
            },
        ),
    ] {
        let fill = w.env.fill_attested_ix(
            &w.solver.key.pubkey(),
            &w.owner(),
            &w.market,
            0,
            &payee,
            Some(&w.fee_to),
            15,
        );
        let solver = w.solver.key.insecure_clone();
        assert_eq!(
            w.env
                .send(&solver, &[ed25519_ix(&attestor, &message), fill], &[])
                .err(),
            Some(engine_error_at(1, EngineError::SigMessage))
        );
    }
    Ok(())
}

#[test]
fn disabling_the_kind_does_not_strand_open_attested_intents() -> TestResult {
    let mut w = world()?;
    let authority = w.env.authority.insecure_clone();
    let mut settings = w.env.settings();
    settings.enabled_kinds = Kind::SwapExactIn.bit();
    let ix = w.env.update_config_ix(&authority.pubkey(), settings);
    w.env.send(&authority, &[ix], &[])?;
    let attestor = w.attestor.insecure_clone();
    let payee = w.solver.input;
    w.fill(&attestor, 0, &payee, 15, &payee, 15)?;
    assert_eq!(w.env.balance(&payee)?, ESCROW - 1);
    Ok(())
}

#[test]
fn attested_fill_compute_stays_within_its_measured_budget() -> TestResult {
    let mut w = world()?;
    let attestor = w.attestor.insecure_clone();
    let payee = w.solver.input;
    let meta = w.fill(&attestor, 0, &payee, 15, &payee, 15)?;
    let fee_bump = Pubkey::find_program_address(
        &[
            w.env.config()?.fee_recipient.as_ref(),
            w.market.input_program.as_ref(),
            w.market.input_mint.as_ref(),
        ],
        &anchor_spl::associated_token::ID,
    )
    .1;
    let normalized = meta
        .compute_units_consumed
        .saturating_sub(bump_search_cost(fee_bump));
    cu_gate(&format!("attested_fill{CU_SUFFIX}"), normalized)
}

#[test]
fn an_attested_fill_pays_the_fee_in_force_when_it_lands_up_to_the_bound_its_submitter_names() -> TestResult {
    let mut w = world()?;
    let attestor = w.attestor.insecure_clone();
    let payee = w.solver.input;
    let admin = w.env.authority.insecure_clone();
    let raise = w.env.economics_ix(
        &admin.pubkey(),
        intent_engine::Economics {
            kind_fee_mask: u8::try_from(intent_core::kinds::Kind::AttestedResult.bit())?,
            kind_fee_bps: [0, 0, 0, 100],
            partner_cut_bps: 0,
            crank_bounty: 0,
            create_fee: 0,
        },
    );
    w.env.send(&admin, &[raise], &[])?;
    w.env.max_fee_bps = 100;
    w.fill(&attestor, 0, &payee, 15, &payee, 15)?;
    let fees = intent_core::fee::split_fees(ESCROW, 100, 0, 0).map_err(|e| format!("{e:?}"))?;
    assert_eq!(w.env.balance(&payee)?, fees.net);
    assert_eq!(w.env.balance(&w.fee_to)?, fees.protocol);
    assert!(fees.protocol > 1);
    Ok(())
}

#[test]
fn an_attested_solver_bounds_the_fee_it_will_pay() -> TestResult {
    let mut w = world()?;
    let attestor = w.attestor.insecure_clone();
    let payee = w.solver.input;
    let fee_bps = w.env.config()?.fee_bps;
    w.env.max_fee_bps = fee_bps - 1;
    assert_eq!(
        w.fill(&attestor, 0, &payee, 15, &payee, 15).err(),
        Some(engine_error_at(1, EngineError::FeeAboveBound))
    );
    w.env.max_fee_bps = fee_bps;
    w.fill(&attestor, 0, &payee, 15, &payee, 15)?;
    Ok(())
}
