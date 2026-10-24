use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use intent_core::kinds::{attested_result, swap_exact_in, Kind};
use intent_engine::errors::EngineError;
use intent_engine::events::{FeeWithheld, WITHHELD_JUDGE};
use solana_instruction::Instruction;
use solana_instruction_error::InstructionError;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    agent_lane, anchor_error, anchor_error_at, attestation_message, attestation_proof_message,
    canonical_refund, delegate_pda, ed25519_ix, engine_error, engine_error_at, events, intent_pda,
    mandate_pda, mandate_terms, partner_ext, relayed, swap_spec, vault_pda, Env, IntentSpec,
    Market, MintExt, TestResult, Trader, DOMAIN, START_TS,
};

const FUNDED: u64 = 1_000;
const ESCROW: u64 = 400;
const SUBMIT_BY: i64 = START_TS + 600;

fn setup() -> TestResult<(Env, Market, Trader)> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(anchor_spl::token::ID, &[], anchor_spl::token::ID, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    Ok((env, market, trader))
}

fn swap_with(nonce: u64, amount_in: u64, min_out: u64) -> TestResult<IntentSpec> {
    Ok(IntentSpec {
        params: swap_exact_in::Params { amount_in, min_out }
            .encode()
            .map_err(|e| format!("{e:?}"))?,
        ..swap_spec(nonce, amount_in)?
    })
}

fn forge(ix: &mut Instruction, real: &Pubkey, fake: Pubkey) -> TestResult {
    let meta = ix
        .accounts
        .iter_mut()
        .find(|m| m.pubkey == *real && !m.is_signer)
        .ok_or("account not in instruction")?;
    meta.pubkey = fake;
    Ok(())
}

fn forge_at(ix: &mut Instruction, at: usize, fake: Pubkey) -> TestResult {
    ix.accounts.get_mut(at).ok_or("index")?.pubkey = fake;
    Ok(())
}

fn loot(env: &mut Env, market: &Market) -> TestResult<(Keypair, Pubkey)> {
    let thief = env.funded()?;
    let account =
        env.create_token_account(&market.input_mint, &thief.pubkey(), market.input_program)?;
    Ok((thief, account))
}

#[test]
fn an_expiry_cannot_name_a_thief_as_the_owners_canonical_account() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    env.create_intent(&trader, &market, &swap_spec(0, ESCROW)?)?;
    env.set_now(START_TS + 3_600);
    let (thief, stolen) = loot(&mut env, &market)?;
    let mut ix = env.expire_ix(&thief.pubkey(), &owner, &market, 0, &stolen);
    forge(&mut ix, &canonical_refund(&owner, &market), stolen)?;
    assert_eq!(
        env.send(&thief, &[ix], &[]),
        Err(engine_error(EngineError::RefundNotCanonical))
    );
    assert_eq!(env.balance(&stolen)?, 0);
    assert_eq!(
        env.intent(&owner, 0)?.status,
        intent_core::lifecycle::Status::Open as u8
    );
    Ok(())
}

#[test]
fn a_close_cannot_name_a_thief_as_the_owners_canonical_account() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    env.create_intent(&trader, &market, &swap_spec(0, ESCROW)?)?;
    let cancel = env.cancel_ix(&owner, &market, 0, &trader.input);
    env.send(&trader.key, &[cancel], &[])?;
    let vault = svm_tests::vault_pda(&intent_pda(&owner, 0));
    env.mint_to(&market.input_mint, &vault, market.input_program, 25)?;
    let (_, stolen) = loot(&mut env, &market)?;
    let mut ix = env.close_ix(&owner, &market, 0, &stolen);
    forge(&mut ix, &canonical_refund(&owner, &market), stolen)?;
    assert_eq!(
        env.send(&trader.key, &[ix], &[]),
        Err(engine_error(EngineError::RefundNotCanonical))
    );
    assert_eq!((env.balance(&stolen)?, env.balance(&vault)?), (0, 25));
    Ok(())
}

#[test]
fn a_close_cannot_name_anyone_but_the_intents_owner() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    env.create_intent(&trader, &market, &swap_spec(0, ESCROW)?)?;
    let cancel = env.cancel_ix(&owner, &market, 0, &trader.input);
    env.send(&trader.key, &[cancel], &[])?;
    let stranger = env.funded()?;
    let mut ix = env.close_ix(&owner, &market, 0, &trader.input);
    forge_at(&mut ix, 6, stranger.pubkey())?;
    assert_eq!(
        env.send(&trader.key, &[ix], &[]),
        Err(engine_error(EngineError::Unauthorized))
    );
    assert!(env.exists(&intent_pda(&owner, 0)));
    Ok(())
}

#[test]
fn a_create_cannot_escrow_from_a_strangers_token_account() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let stranger = env.trader(&market, FUNDED)?;
    let mut ix = env.create_intent_ix(&trader, &market, &swap_spec(0, ESCROW)?);
    forge(&mut ix, &trader.input, stranger.input)?;
    assert_eq!(
        env.send(&trader.key, &[ix], &[]),
        Err(anchor_error(ErrorCode::ConstraintTokenOwner))
    );
    assert_eq!(env.balance(&stranger.input)?, FUNDED);
    Ok(())
}

fn signed_world() -> TestResult<(Env, Market, Trader, Keypair, IntentSpec)> {
    let (mut env, market, trader) = setup()?;
    env.approve_delegate(&trader, &market, ESCROW)?;
    let relayer = env.funded()?;
    Ok((env, market, trader, relayer, swap_spec(7, ESCROW)?))
}

#[test]
fn a_relayed_create_cannot_escrow_from_a_strangers_account_or_delegate() -> TestResult {
    let (mut env, market, trader, relayer, spec) = signed_world()?;
    let stranger = env.trader(&market, FUNDED)?;
    env.approve_delegate(&stranger, &market, FUNDED)?;
    let signed = ed25519_ix(
        &trader.key,
        &env.signed_message(&trader, &market, &spec, DOMAIN, SUBMIT_BY),
    );
    let mut from_stranger =
        env.create_signed_ix(&relayer.pubkey(), &trader, &market, &spec, SUBMIT_BY);
    forge(&mut from_stranger, &trader.input, stranger.input)?;
    assert_eq!(
        env.send(&relayer, &[signed.clone(), from_stranger], &[]),
        Err(anchor_error_at(1, ErrorCode::ConstraintTokenOwner))
    );
    let mut their_delegate =
        env.create_signed_ix(&relayer.pubkey(), &trader, &market, &spec, SUBMIT_BY);
    forge(
        &mut their_delegate,
        &delegate_pda(&trader.key.pubkey()),
        delegate_pda(&stranger.key.pubkey()),
    )?;
    assert_eq!(
        env.send(&relayer, &[signed, their_delegate], &[]),
        Err(anchor_error_at(1, ErrorCode::ConstraintSeeds))
    );
    assert_eq!(
        (env.balance(&stranger.input)?, env.balance(&trader.input)?),
        (FUNDED, FUNDED)
    );
    Ok(())
}

#[test]
fn neither_a_relayer_nor_an_agent_can_send_the_create_fee_elsewhere() -> TestResult {
    let (mut env, market, trader, relayer, spec) = signed_world()?;
    let thief = env.funded()?.pubkey();
    let treasury = env.config()?.fee_recipient;
    let signed = ed25519_ix(
        &trader.key,
        &env.signed_message(&trader, &market, &spec, DOMAIN, SUBMIT_BY),
    );
    let mut relayed = env.create_signed_ix(&relayer.pubkey(), &trader, &market, &spec, SUBMIT_BY);
    forge(&mut relayed, &treasury, thief)?;
    assert_eq!(
        env.send(&relayer, &[signed, relayed], &[]),
        Err(engine_error_at(1, EngineError::TreasuryMismatch))
    );
    let agent = env.funded()?;
    let grant = env.create_mandate_ix(
        &trader,
        &market,
        mandate_terms(agent.pubkey(), START_TS + 86_400),
    );
    let owner = trader.key.insecure_clone();
    env.send(&owner, &[grant], &[])?;
    let mandate = mandate_pda(&owner.pubkey(), &agent.pubkey(), 0);
    let drawn = swap_with(agent_lane(1, 0), ESCROW, ESCROW / 2)?;
    let mut by_agent = env.agent_intent_ix(&agent.pubkey(), mandate, &trader, &market, &drawn);
    forge(&mut by_agent, &treasury, thief)?;
    assert_eq!(
        env.send(&agent, &[by_agent], &[]),
        Err(engine_error(EngineError::TreasuryMismatch))
    );
    let stranger = env.trader(&market, FUNDED)?;
    env.approve_delegate(&stranger, &market, FUNDED)?;
    let mut their_delegate =
        env.agent_intent_ix(&agent.pubkey(), mandate, &trader, &market, &drawn);
    forge(
        &mut their_delegate,
        &delegate_pda(&owner.pubkey()),
        delegate_pda(&stranger.key.pubkey()),
    )?;
    assert_eq!(
        env.send(&agent, &[their_delegate], &[]),
        Err(anchor_error(ErrorCode::ConstraintSeeds))
    );
    assert_eq!(env.balance(&stranger.input)?, FUNDED);
    Ok(())
}

#[test]
fn an_attested_fill_reads_only_the_real_instructions_sysvar() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    let attestor = Keypair::new();
    let spec = IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: ESCROW,
            min_result: 1,
            max_result: 9,
            attestor: attestor.pubkey().to_bytes(),
            spec_hash: [0; 32],
            judge_fee: 0,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ..swap_spec(0, ESCROW)?
    };
    env.create_intent(&trader, &market, &spec)?;
    let solver = env.solver(&market, 0)?;
    let fee_to = env.fee_account(&market)?;
    let message = attestation_message(
        DOMAIN,
        &attestor.pubkey(),
        &intent_pda(&owner, 0),
        &solver.input,
        ESCROW,
        5,
    );
    let mut fill = env.fill_attested_ix(
        &solver.key.pubkey(),
        &owner,
        &market,
        0,
        &solver.input,
        Some(&fee_to),
        5,
    );
    forge(
        &mut fill,
        &solana_instructions_sysvar::ID,
        Pubkey::new_unique(),
    )?;
    assert_eq!(
        env.send(&solver.key, &[ed25519_ix(&attestor, &message), fill], &[]),
        Err(TransactionError::InstructionError(
            1,
            InstructionError::UnsupportedSysvar
        ))
    );
    assert_eq!(env.balance(&solver.input)?, 0);
    Ok(())
}

#[test]
fn a_fill_must_deliver_the_output_mint_the_intent_names() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    env.create_intent(&trader, &market, &swap_spec(0, ESCROW)?)?;
    let other = env.market(anchor_spl::token::ID, &[], anchor_spl::token::ID, &[])?;
    let solver = env.solver(&market, 1_000)?;
    let fee_to = env.fee_account(&market)?;
    let mut fill = env.fill_ix(
        &solver,
        &owner,
        &market,
        0,
        &trader.receiver,
        Some(&fee_to),
        1_000,
    );
    forge(&mut fill, &market.output_mint, other.output_mint)?;
    assert_eq!(
        env.send(&solver.key, &[fill], &[]),
        Err(anchor_error(ErrorCode::ConstraintHasOne))
    );
    assert_eq!(env.balance(&trader.receiver)?, 0);
    Ok(())
}

#[test]
fn an_intent_whose_status_byte_is_unknown_is_refused() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    env.create_intent(&trader, &market, &swap_spec(0, ESCROW)?)?;
    let intent = intent_pda(&owner, 0);
    let mut account = env.svm.get_account(&intent).ok_or("intent missing")?;
    *account
        .data
        .get_mut(8 + 4 * 32 + 4 * 8 + 1)
        .ok_or("short")? = 9;
    env.svm.set_account(intent, account)?;
    assert_eq!(env.intent(&owner, 0)?.status, 9);
    let cancel = env.cancel_ix(&owner, &market, 0, &trader.input);
    assert_eq!(
        env.send(&trader.key, &[cancel], &[]),
        Err(engine_error(EngineError::UnknownStatus))
    );
    assert_eq!(env.balance(&trader.input)?, FUNDED - ESCROW);
    Ok(())
}

#[test]
fn every_authority_must_actually_sign() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    env.create_intent(&trader, &market, &swap_spec(0, ESCROW)?)?;
    let solver = env.solver(&market, 1_000)?;
    let fee_to = env.fee_account(&market)?;
    let agent = env.funded()?;
    let admin = env.authority.pubkey();
    let guardian = env.guardian.pubkey();
    let mandate = mandate_pda(&owner, &agent.pubkey(), 0);
    let cases: Vec<(&str, Instruction, Pubkey)> = vec![
        (
            "create_intent",
            env.create_intent_ix(&trader, &market, &swap_spec(1, 10)?),
            owner,
        ),
        (
            "cancel_intent",
            env.cancel_ix(&owner, &market, 0, &trader.input),
            owner,
        ),
        ("advance_nonce", env.advance_ix(&owner, 5), owner),
        ("advance_epoch", env.advance_epoch_ix(&owner, 5), owner),
        (
            "create_mandate",
            env.create_mandate_ix(
                &trader,
                &market,
                mandate_terms(agent.pubkey(), START_TS + 86_400),
            ),
            owner,
        ),
        (
            "revoke_mandate",
            env.revoke_mandate_ix(&owner, mandate),
            owner,
        ),
        (
            "agent_create",
            env.agent_intent_ix(
                &agent.pubkey(),
                mandate,
                &trader,
                &market,
                &swap_with(agent_lane(1, 0), 10, 5)?,
            ),
            agent.pubkey(),
        ),
        (
            "fill_intent",
            env.fill_ix(
                &solver,
                &owner,
                &market,
                0,
                &trader.receiver,
                Some(&fee_to),
                1_000,
            ),
            solver.key.pubkey(),
        ),
        (
            "begin_fill",
            env.begin_fill_ix(
                &solver.key.pubkey(),
                &owner,
                &market,
                0,
                &solver.input,
                Some(&fee_to),
                1,
            ),
            solver.key.pubkey(),
        ),
        (
            "end_fill",
            env.end_fill_ix(
                &solver.key.pubkey(),
                &owner,
                &market,
                0,
                &trader.receiver,
                &solver.output,
                1_000,
            ),
            solver.key.pubkey(),
        ),
        (
            "update_config",
            env.update_config_ix(&admin, env.settings()),
            admin,
        ),
        (
            "propose_admin",
            env.propose_admin_ix(&admin, Pubkey::new_unique()),
            admin,
        ),
        ("raise_pause", env.raise_pause_ix(&guardian, 1), guardian),
        ("lower_pause", env.lower_pause_ix(&admin, 1), admin),
    ];
    let payer = env.funded()?;
    for (name, mut ix, signer) in cases {
        let mut cleared = 0;
        for meta in ix
            .accounts
            .iter_mut()
            .filter(|m| m.pubkey == signer && m.is_signer)
        {
            meta.is_signer = false;
            cleared += 1;
        }
        assert_eq!(cleared, 1, "{name}");
        assert_eq!(
            env.send(&payer, &[ix], &[]).err(),
            Some(anchor_error(ErrorCode::AccountNotSigner)),
            "{name}"
        );
    }
    Ok(())
}

#[test]
fn a_second_admin_proposal_replaces_the_first() -> TestResult {
    let (mut env, _, _) = setup()?;
    let admin = env.authority.insecure_clone();
    let first = env.funded()?;
    let second = env.funded()?;
    for nominee in [first.pubkey(), second.pubkey()] {
        let ix = env.propose_admin_ix(&admin.pubkey(), nominee);
        env.send(&admin, &[ix], &[])?;
    }
    let ix = env.accept_admin_ix(&first.pubkey());
    assert_eq!(
        env.send(&first, &[ix], &[]),
        Err(engine_error(EngineError::NotPendingAdmin))
    );
    let ix = env.accept_admin_ix(&second.pubkey());
    env.send(&second, &[ix], &[])?;
    assert_eq!(env.config()?.admin, second.pubkey());
    Ok(())
}

#[test]
fn a_replaced_guardian_can_no_longer_pause() -> TestResult {
    let (mut env, _, _) = setup()?;
    let admin = env.authority.insecure_clone();
    let old = env.guardian.insecure_clone();
    let fresh = env.funded()?;
    let mut settings = env.settings();
    settings.guardian = fresh.pubkey();
    let ix = env.update_config_ix(&admin.pubkey(), settings);
    env.send(&admin, &[ix], &[])?;
    let ix = env.raise_pause_ix(&old.pubkey(), 1);
    assert_eq!(
        env.send(&old, &[ix], &[]),
        Err(engine_error(EngineError::Unauthorized))
    );
    let ix = env.raise_pause_ix(&fresh.pubkey(), 1);
    env.send(&fresh, &[ix], &[])?;
    assert_eq!(env.config()?.paused, 1);
    Ok(())
}

#[test]
fn a_one_unit_intent_owing_two_fees_cannot_fill_but_cancels_in_full() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    let partner = Pubkey::new_unique();
    let spec = IntentSpec {
        ext: svm_tests::partner_ext(&partner, 1),
        ..swap_with(0, 1, 1)?
    };
    env.create_intent(&trader, &market, &spec)?;
    env.partner_to = Some(env.create_ata(&partner, &market.input_mint, market.input_program)?);
    let solver = env.solver(&market, 1_000)?;
    let fee_to = env.fee_account(&market)?;
    let fill = env.fill_ix(
        &solver,
        &owner,
        &market,
        0,
        &trader.receiver,
        Some(&fee_to),
        1,
    );
    assert_eq!(
        env.send(&solver.key, &[fill], &[]),
        Err(engine_error(EngineError::InvalidParams))
    );
    let cancel = env.cancel_ix(&owner, &market, 0, &trader.input);
    env.send(&trader.key, &[cancel], &[])?;
    assert_eq!(env.balance(&trader.input)?, FUNDED);
    Ok(())
}

#[test]
fn sol_sent_ahead_to_an_intent_vault_mandate_or_user_address_blocks_nothing_and_closes_out(
) -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    let intent = intent_pda(&owner, 0);
    let vault = svm_tests::vault_pda(&intent);
    let gift = 1_000_000_000;
    for address in [intent, vault] {
        env.svm
            .airdrop(&address, gift)
            .map_err(|e| format!("{:?}", e.err))?;
    }
    env.create_intent(&trader, &market, &swap_spec(0, ESCROW)?)?;
    assert_eq!(env.balance(&vault)?, ESCROW);
    let held = env
        .lamports(&intent)
        .checked_add(env.lamports(&vault))
        .ok_or("overflow")?;
    assert!(held >= 2 * gift);
    let cancel = env.cancel_ix(&owner, &market, 0, &trader.input);
    env.send(&trader.key, &[cancel], &[])?;
    let before = env.lamports(&owner);
    let close = env.close_ix(&owner, &market, 0, &trader.input);
    env.send(&trader.key, &[close], &[])?;
    assert!(!env.exists(&intent) && !env.exists(&vault));
    assert_eq!(env.lamports(&owner), before + held - 5_000);
    let agent = env.funded()?;
    let mandate = mandate_pda(&owner, &agent.pubkey(), 0);
    env.svm
        .airdrop(&mandate, gift)
        .map_err(|e| format!("{:?}", e.err))?;
    let grant = env.create_mandate_ix(
        &trader,
        &market,
        mandate_terms(agent.pubkey(), START_TS + 86_400),
    );
    env.send(&trader.key, &[grant], &[])?;
    assert_eq!(env.mandate(&mandate)?.owner, owner);
    let fresh = env.funded()?;
    env.svm
        .airdrop(&svm_tests::user_pda(&fresh.pubkey()), gift)
        .map_err(|e| format!("{:?}", e.err))?;
    env.init_user(&fresh)?;
    assert_eq!(env.user(&fresh.pubkey())?.owner, fresh.pubkey());
    Ok(())
}

#[test]
fn tokens_without_decimals_escrow_fill_and_refund_in_whole_units() -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let program = anchor_spl::token::ID;
    let market = Market {
        input_mint: env.create_mint_with_decimals(program, &[], 0)?,
        output_mint: env.create_mint_with_decimals(program, &[], 0)?,
        input_program: program,
        output_program: program,
    };
    assert_eq!(
        (
            env.decimals(&market.input_mint)?,
            env.decimals(&market.output_mint)?
        ),
        (0, 0)
    );
    let trader = env.trader(&market, FUNDED)?;
    let owner = trader.key.pubkey();
    env.create_intent(&trader, &market, &swap_with(0, ESCROW, 7)?)?;
    env.create_intent(&trader, &market, &swap_with(1, ESCROW, 7)?)?;
    let solver = env.solver(&market, 100)?;
    let fee_to = env.fee_account(&market)?;
    let fill = env.fill_ix(
        &solver,
        &owner,
        &market,
        0,
        &trader.receiver,
        Some(&fee_to),
        7,
    );
    env.send(&solver.key, &[fill], &[])?;
    let fees = intent_core::fee::split_fees(ESCROW, env.config()?.fee_bps, 0, 0)
        .map_err(|e| format!("{e:?}"))?;
    assert_eq!(
        (
            env.balance(&trader.receiver)?,
            env.balance(&solver.input)?,
            env.balance(&fee_to)?
        ),
        (7, fees.net, fees.protocol)
    );
    let cancel = env.cancel_ix(&owner, &market, 1, &trader.input);
    env.send(&trader.key, &[cancel], &[])?;
    assert_eq!(env.balance(&trader.input)?, FUNDED - ESCROW);
    Ok(())
}

#[test]
fn a_clock_that_runs_backwards_only_moves_expiry_and_dutch_prices_with_it() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    let dutch = IntentSpec {
        kind: Kind::DutchAuction as u8,
        params: intent_core::kinds::dutch_auction::Params {
            amount_in: ESCROW,
            start_out: 900,
            end_out: 100,
            start_ts: START_TS + 100,
            end_ts: START_TS + 200,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        expires_at: START_TS + 300,
        ..swap_spec(0, ESCROW)?
    };
    env.create_intent(&trader, &market, &dutch)?;
    let solver = env.solver(&market, 1_000)?;
    let fee_to = env.fee_account(&market)?;
    env.set_now(START_TS + 300);
    let refund = canonical_refund(&owner, &market);
    let cranker = env.funded()?;
    env.set_now(START_TS + 250);
    let early = env.expire_ix(&cranker.pubkey(), &owner, &market, 0, &refund);
    assert_eq!(
        env.send(&cranker, &[early], &[]),
        Err(engine_error(EngineError::NotExpired))
    );
    env.set_now(START_TS + 50);
    let cheap = env.fill_ix(
        &solver,
        &owner,
        &market,
        0,
        &trader.receiver,
        Some(&fee_to),
        899,
    );
    assert_eq!(
        env.send(&solver.key, &[cheap], &[]),
        Err(engine_error(EngineError::InsufficientOutput))
    );
    let full = env.fill_ix(
        &solver,
        &owner,
        &market,
        0,
        &trader.receiver,
        Some(&fee_to),
        900,
    );
    env.send(&solver.key, &[full], &[])?;
    assert_eq!(env.balance(&trader.receiver)?, 900);
    Ok(())
}

#[test]
fn owner_and_admin_operations_stay_within_their_measured_compute() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    let admin = env.authority.insecure_clone();
    let mut measured = Vec::new();
    let ix = env.advance_ix(&owner, 7);
    measured.push((
        "advance_nonce".to_owned(),
        env.send(&trader.key, &[ix], &[])?.compute_units_consumed,
    ));
    let ix = env.economics_ix(
        &admin.pubkey(),
        intent_engine::Economics {
            kind_fee_mask: 0,
            kind_fee_bps: [0; 4],
            partner_cut_bps: 0,
            crank_bounty: 50_000,
            create_fee: 0,
        },
    );
    measured.push((
        "update_economics".to_owned(),
        env.send(&admin, &[ix], &[])?.compute_units_consumed,
    ));
    let agent = env.funded()?;
    let grant = env.create_mandate_ix(
        &trader,
        &market,
        mandate_terms(agent.pubkey(), START_TS + 86_400),
    );
    env.send(&trader.key, &[grant], &[])?;
    let revoke = env.revoke_mandate_ix(&owner, mandate_pda(&owner, &agent.pubkey(), 0));
    measured.push((
        "revoke_mandate".to_owned(),
        env.send(&trader.key, &[revoke], &[])?
            .compute_units_consumed,
    ));
    env.create_intent(&trader, &market, &swap_spec(8, ESCROW)?)?;
    let solver = env.solver(&market, 1_000)?;
    let fee_to = env.fee_account(&market)?;
    let fill = env.fill_ix(
        &solver,
        &owner,
        &market,
        8,
        &trader.receiver,
        Some(&fee_to),
        1_000,
    );
    env.send(&solver.key, &[fill], &[])?;
    let cranker = env.funded()?;
    let close = env.close_ix_by(&cranker.pubkey(), &owner, &market, 8, &trader.input);
    let closed = env.send(&cranker, &[close], &[])?.compute_units_consumed;
    let refund_bump = Pubkey::find_program_address(
        &[
            owner.as_ref(),
            market.input_program.as_ref(),
            market.input_mint.as_ref(),
        ],
        &anchor_spl::associated_token::ID,
    )
    .1;
    measured.push((
        "close_with_bounty".to_owned(),
        closed.saturating_sub(svm_tests::bump_search_cost(refund_bump)),
    ));
    svm_tests::cu_gates(&measured)
}

#[test]
fn no_settling_instruction_takes_another_intents_vault_or_another_owners_intent() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    let rival = env.trader(&market, FUNDED)?;
    for nonce in [0, 1] {
        env.create_intent(&trader, &market, &swap_with(nonce, ESCROW / 2, 100)?)?;
    }
    env.create_intent(&rival, &market, &swap_with(0, ESCROW / 2, 100)?)?;
    let solver = env.solver(&market, 1_000)?;
    let fee_to = env.fee_account(&market)?;
    let ours = vault_pda(&intent_pda(&owner, 0));
    let sibling = vault_pda(&intent_pda(&owner, 1));
    let theirs = intent_pda(&rival.key.pubkey(), 0);
    let fill = env.fill_ix(
        &solver,
        &owner,
        &market,
        0,
        &trader.receiver,
        Some(&fee_to),
        100,
    );
    let begin = env.begin_fill_ix(
        &solver.key.pubkey(),
        &owner,
        &market,
        0,
        &solver.input,
        Some(&fee_to),
        1,
    );
    for (ix, foreign) in [
        (fill, ErrorCode::ConstraintHasOne),
        (begin, ErrorCode::ConstraintSeeds),
    ] {
        let mut wrong_vault = ix.clone();
        forge(&mut wrong_vault, &ours, sibling)?;
        assert_eq!(
            env.send(&solver.key, &[wrong_vault], &[]),
            Err(anchor_error(ErrorCode::ConstraintSeeds))
        );
        let mut wrong_intent = ix;
        forge(&mut wrong_intent, &intent_pda(&owner, 0), theirs)?;
        assert_eq!(
            env.send(&solver.key, &[wrong_intent], &[]).map(|_| ()),
            Err(anchor_error(foreign))
        );
    }
    env.set_now(START_TS + 7_200);
    let cranker = env.funded()?;
    let refund = canonical_refund(&owner, &market);
    let mut expire = env.expire_ix(&cranker.pubkey(), &owner, &market, 0, &refund);
    forge(&mut expire, &ours, sibling)?;
    assert_eq!(
        env.send(&cranker, &[expire], &[]),
        Err(anchor_error(ErrorCode::ConstraintSeeds))
    );
    let expire = env.expire_ix(&cranker.pubkey(), &owner, &market, 0, &refund);
    env.send(&cranker, &[expire], &[])?;
    let mut close = env.close_ix_by(&cranker.pubkey(), &owner, &market, 0, &refund);
    forge(&mut close, &ours, sibling)?;
    assert_eq!(
        env.send(&cranker, &[close], &[]),
        Err(anchor_error(ErrorCode::ConstraintSeeds))
    );
    assert_eq!(
        (env.balance(&sibling)?, env.balance(&vault_pda(&theirs))?),
        (ESCROW / 2, ESCROW / 2)
    );
    let close = env.close_ix_by(&cranker.pubkey(), &owner, &market, 0, &refund);
    env.send(&cranker, &[close], &[])?;
    assert!(!env.exists(&intent_pda(&owner, 0)));
    Ok(())
}

#[test]
fn an_agent_cannot_draw_on_one_owner_under_another_owners_grant() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let rival = env.trader(&market, FUNDED)?;
    let agent = env.funded()?;
    for who in [&trader, &rival] {
        env.approve_delegate(who, &market, FUNDED)?;
        let grant = env.create_mandate_ix(
            who,
            &market,
            mandate_terms(agent.pubkey(), START_TS + 86_400),
        );
        let key = who.key.insecure_clone();
        env.send(&key, &[grant], &[])?;
    }
    let theirs = mandate_pda(&rival.key.pubkey(), &agent.pubkey(), 0);
    let drawn = swap_with(agent_lane(1, 0), ESCROW, ESCROW / 2)?;
    let crossed = env.agent_intent_ix(&agent.pubkey(), theirs, &trader, &market, &drawn);
    assert_eq!(
        env.send(&agent, &[crossed], &[]).map(|_| ()),
        Err(engine_error(EngineError::Unauthorized))
    );
    let ours = mandate_pda(&trader.key.pubkey(), &agent.pubkey(), 0);
    let impostor = env.funded()?;
    let stolen = env.agent_intent_ix(&impostor.pubkey(), ours, &trader, &market, &drawn);
    assert_eq!(
        env.send(&impostor, &[stolen], &[]).map(|_| ()),
        Err(engine_error(EngineError::Unauthorized))
    );
    assert_eq!(
        (env.balance(&trader.input)?, env.balance(&rival.input)?),
        (FUNDED, FUNDED)
    );
    let fair = env.agent_intent_ix(&agent.pubkey(), ours, &trader, &market, &drawn);
    env.send(&agent, &[fair], &[])?;
    assert_eq!(env.balance(&trader.input)?, FUNDED - ESCROW);
    Ok(())
}

#[test]
fn an_admin_nomination_is_accepted_once_and_only_by_the_nominee() -> TestResult {
    let (mut env, _, _) = setup()?;
    let admin = env.authority.insecure_clone();
    let nominee = env.funded()?;
    let stranger = env.funded()?;
    let early = env.accept_admin_ix(&nominee.pubkey());
    assert_eq!(
        env.send(&nominee, &[early], &[]),
        Err(engine_error(EngineError::NotPendingAdmin))
    );
    let propose = env.propose_admin_ix(&admin.pubkey(), nominee.pubkey());
    env.send(&admin, &[propose], &[])?;
    let hijack = env.accept_admin_ix(&stranger.pubkey());
    assert_eq!(
        env.send(&stranger, &[hijack], &[]),
        Err(engine_error(EngineError::NotPendingAdmin))
    );
    let accept = env.accept_admin_ix(&nominee.pubkey());
    env.send(&nominee, &[accept], &[])?;
    assert_eq!(env.config()?.admin, nominee.pubkey());
    let again = env.accept_admin_ix(&nominee.pubkey());
    assert_eq!(
        env.send(&nominee, &[again], &[]),
        Err(engine_error(EngineError::NotPendingAdmin))
    );
    let stale = env.accept_admin_ix(&admin.pubkey());
    assert_eq!(
        env.send(&admin, &[stale], &[]),
        Err(engine_error(EngineError::NotPendingAdmin))
    );
    Ok(())
}

#[test]
fn an_attested_fill_under_cpi_still_binds_the_payee_and_cannot_redirect() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    let attestor = Keypair::new();
    let spec = IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: ESCROW,
            min_result: 1,
            max_result: 9,
            attestor: attestor.pubkey().to_bytes(),
            spec_hash: [0; 32],
            judge_fee: 0,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ..swap_spec(0, ESCROW)?
    };
    env.create_intent(&trader, &market, &spec)?;
    let solver = env.solver(&market, 0)?;
    let fee_to = env.fee_account(&market)?;
    let thief = env.create_token_account(
        &market.input_mint,
        &Pubkey::new_unique(),
        market.input_program,
    )?;
    let message = attestation_message(
        DOMAIN,
        &attestor.pubkey(),
        &intent_pda(&owner, 0),
        &solver.input,
        ESCROW,
        5,
    );
    let fill = env.fill_attested_ix(
        &solver.key.pubkey(),
        &owner,
        &market,
        0,
        &thief,
        Some(&fee_to),
        5,
    );
    let under_cpi = relayed(intent_engine::ID, fill);
    assert_eq!(
        env.send(
            &solver.key,
            &[ed25519_ix(&attestor, &message), under_cpi],
            &[]
        )
        .err(),
        Some(engine_error_at(1, EngineError::SigMessage)),
        "running fill_attested under a CPI does not relax the payee binding"
    );
    assert_eq!(env.balance(&thief)?, 0);
    assert_eq!(
        env.balance(&vault_pda(&intent_pda(&owner, 0)))?,
        ESCROW,
        "escrow untouched"
    );
    Ok(())
}

#[test]
fn a_proof_intent_settles_only_against_an_attestation_binding_the_committed_spec() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    let attestor = Keypair::new();
    const SPEC: [u8; 32] = [0x5a; 32];
    let spec = IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: ESCROW,
            min_result: 1,
            max_result: 1,
            attestor: attestor.pubkey().to_bytes(),
            spec_hash: SPEC,
            judge_fee: 0,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ..swap_spec(0, ESCROW)?
    };
    env.create_intent(&trader, &market, &spec)?;
    let solver = env.solver(&market, 0)?;
    let fee_to = env.fee_account(&market)?;
    let payee = solver.input;
    let intent = intent_pda(&owner, 0);
    let delivery = env.announce_for(&solver.key, &intent)?;

    let plain = attestation_message(DOMAIN, &attestor.pubkey(), &intent, &payee, ESCROW, 1);
    let fill = env.fill_attested_ix(
        &solver.key.pubkey(),
        &owner,
        &market,
        0,
        &payee,
        Some(&fee_to),
        1,
    );
    assert_eq!(
        env.send(&solver.key, &[ed25519_ix(&attestor, &plain), fill], &[])
            .err(),
        Some(engine_error_at(1, EngineError::SigMessage)),
        "a plain attestation cannot settle a proof intent"
    );

    let wrong = attestation_proof_message(
        DOMAIN,
        &attestor.pubkey(),
        &intent,
        &payee,
        ESCROW,
        1,
        [0x11; 32],
        &delivery,
    );
    let fill = env.fill_attested_ix(
        &solver.key.pubkey(),
        &owner,
        &market,
        0,
        &payee,
        Some(&fee_to),
        1,
    );
    assert_eq!(
        env.send(&solver.key, &[ed25519_ix(&attestor, &wrong), fill], &[])
            .err(),
        Some(engine_error_at(1, EngineError::SigMessage)),
        "a verdict over the wrong spec cannot settle"
    );

    let right = attestation_proof_message(
        DOMAIN,
        &attestor.pubkey(),
        &intent,
        &payee,
        ESCROW,
        1,
        SPEC,
        &delivery,
    );
    let fill = env.fill_attested_ix(
        &solver.key.pubkey(),
        &owner,
        &market,
        0,
        &payee,
        Some(&fee_to),
        1,
    );
    env.send(&solver.key, &[ed25519_ix(&attestor, &right), fill], &[])?;
    assert_eq!(
        env.balance(&payee)?,
        ESCROW - 1,
        "the committed-spec verdict settles to the payee"
    );
    Ok(())
}

#[test]
fn a_proof_intent_pays_the_judge_out_of_the_escrow_and_only_to_its_canonical_account() -> TestResult
{
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    let attestor = Keypair::new();
    const SPEC: [u8; 32] = [0x7a; 32];
    const JF: u64 = 40;
    let spec = IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: ESCROW,
            min_result: 1,
            max_result: 1,
            attestor: attestor.pubkey().to_bytes(),
            spec_hash: SPEC,
            judge_fee: JF,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ..swap_spec(0, ESCROW)?
    };
    env.create_intent(&trader, &market, &spec)?;
    let intent = intent_pda(&owner, 0);
    assert_eq!(
        env.balance(&vault_pda(&intent))?,
        ESCROW,
        "the escrow holds amount_in, not amount_in+fee"
    );
    let solver = env.solver(&market, 0)?;
    let fee_to = env.fee_account(&market)?;
    let payee = solver.input;
    let judge_ata = env.create_ata(&attestor.pubkey(), &market.input_mint, market.input_program)?;
    let delivery = env.announce_for(&solver.key, &intent)?;
    let msg = attestation_proof_message(
        DOMAIN,
        &attestor.pubkey(),
        &intent,
        &payee,
        ESCROW,
        1,
        SPEC,
        &delivery,
    );

    let fill = env.fill_attested_ix(
        &solver.key.pubkey(),
        &owner,
        &market,
        0,
        &payee,
        Some(&fee_to),
        1,
    );
    assert_eq!(
        env.send(&solver.key, &[ed25519_ix(&attestor, &msg), fill], &[])
            .err(),
        Some(engine_error_at(1, EngineError::FeeAccountMissing)),
        "a judge fee needs the judge's account"
    );

    let stranger = env.create_token_account(
        &market.input_mint,
        &Pubkey::new_unique(),
        market.input_program,
    )?;
    env.judge_to = Some(stranger);
    let fill = env.fill_attested_ix(
        &solver.key.pubkey(),
        &owner,
        &market,
        0,
        &payee,
        Some(&fee_to),
        1,
    );
    assert_eq!(
        env.send(&solver.key, &[ed25519_ix(&attestor, &msg), fill], &[])
            .err(),
        Some(engine_error_at(1, EngineError::FeeAccountNotCanonical)),
        "the judge fee can only go to the attestor's canonical account"
    );

    let fee_before = env.balance(&fee_to)?;
    env.judge_to = Some(judge_ata);
    let fill = env.fill_attested_ix(
        &solver.key.pubkey(),
        &owner,
        &market,
        0,
        &payee,
        Some(&fee_to),
        1,
    );
    env.send(&solver.key, &[ed25519_ix(&attestor, &msg), fill], &[])?;
    let judge_paid = env.balance(&judge_ata)?;
    let worker_paid = env.balance(&payee)?;
    let protocol = env.balance(&fee_to)? - fee_before;
    assert_eq!(judge_paid, JF, "the judge is paid exactly its fee");
    assert_eq!(env.balance(&vault_pda(&intent))?, 0, "the vault is drained");
    assert_eq!(
        judge_paid + worker_paid + protocol,
        ESCROW,
        "nothing is minted or lost"
    );
    assert!(worker_paid > 0, "the worker still gets the remainder");
    Ok(())
}

#[test]
fn a_judge_that_cannot_receive_leaves_its_fee_for_the_owner_to_recover() -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(
        anchor_spl::token::ID,
        &[MintExt::Freezable],
        anchor_spl::token::ID,
        &[],
    )?;
    let trader = env.trader(&market, FUNDED)?;
    let owner = trader.key.pubkey();
    let attestor = Keypair::new();
    const SPEC: [u8; 32] = [0x6c; 32];
    const JF: u64 = 40;
    let spec = IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: ESCROW,
            min_result: 1,
            max_result: 1,
            attestor: attestor.pubkey().to_bytes(),
            spec_hash: SPEC,
            judge_fee: JF,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ..swap_spec(0, ESCROW)?
    };
    env.create_intent(&trader, &market, &spec)?;
    let intent = intent_pda(&owner, 0);
    let solver = env.solver(&market, 0)?;
    let fee_to = env.fee_account(&market)?;
    let payee = solver.input;
    let judge_ata = env.create_ata(&attestor.pubkey(), &market.input_mint, market.input_program)?;
    env.set_frozen(&judge_ata, &market.input_mint, market.input_program, true)?;
    env.judge_to = Some(judge_ata);
    let delivery = env.announce_for(&solver.key, &intent)?;
    let msg = attestation_proof_message(
        DOMAIN,
        &attestor.pubkey(),
        &intent,
        &payee,
        ESCROW,
        1,
        SPEC,
        &delivery,
    );
    let fill = env.fill_attested_ix(
        &solver.key.pubkey(),
        &owner,
        &market,
        0,
        &payee,
        Some(&fee_to),
        1,
    );
    let meta = env.send(&solver.key, &[ed25519_ix(&attestor, &msg), fill], &[])?;

    assert_eq!(
        env.balance(&judge_ata)?,
        0,
        "the frozen judge account receives nothing"
    );
    let withheld: Vec<_> = events::<FeeWithheld>(&meta)
        .into_iter()
        .map(|e| (e.payee, e.account, e.fee, e.role))
        .collect();
    assert_eq!(
        withheld,
        [(attestor.pubkey(), judge_ata, JF, WITHHELD_JUDGE)]
    );
    assert_eq!(
        env.balance(&vault_pda(&intent))?,
        JF,
        "the withheld fee stays in the vault"
    );
    assert!(
        env.balance(&payee)? > 0,
        "the worker is still paid the remainder"
    );

    let before = env.balance(&trader.input)?;
    let cranker = env.funded()?;
    let close = env.close_ix_by(&cranker.pubkey(), &owner, &market, 0, &trader.input);
    env.send(&cranker, &[close], &[])?;
    assert_eq!(
        env.balance(&trader.input)?,
        before + JF,
        "the owner recovers the withheld judge fee on close"
    );
    assert!(!env.exists(&intent), "the intent closes");
    Ok(())
}

#[test]
fn a_proof_intent_with_a_partner_conserves_every_lamport() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    let attestor = Keypair::new();
    let partner = Pubkey::new_unique();
    const SPEC: [u8; 32] = [0x3c; 32];
    const JF: u64 = 40;
    const PARTNER_BPS: u16 = 30;
    let spec = IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: ESCROW,
            min_result: 1,
            max_result: 1,
            attestor: attestor.pubkey().to_bytes(),
            spec_hash: SPEC,
            judge_fee: JF,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ext: partner_ext(&partner, PARTNER_BPS),
        ..swap_spec(0, ESCROW)?
    };
    env.create_intent(&trader, &market, &spec)?;
    let intent = intent_pda(&owner, 0);
    assert_eq!(
        env.balance(&vault_pda(&intent))?,
        ESCROW,
        "the escrow holds amount_in, not amount_in+fee"
    );
    let solver = env.solver(&market, 0)?;
    let fee_to = env.fee_account(&market)?;
    let payee = solver.input;
    let judge_ata = env.create_ata(&attestor.pubkey(), &market.input_mint, market.input_program)?;
    let partner_ata = env.create_ata(&partner, &market.input_mint, market.input_program)?;
    env.judge_to = Some(judge_ata);
    env.partner_to = Some(partner_ata);
    let fee_to_before = env.balance(&fee_to)?;
    let delivery = env.announce_for(&solver.key, &intent)?;
    let msg = attestation_proof_message(
        DOMAIN,
        &attestor.pubkey(),
        &intent,
        &payee,
        ESCROW,
        1,
        SPEC,
        &delivery,
    );
    let fill = env.fill_attested_ix(
        &solver.key.pubkey(),
        &owner,
        &market,
        0,
        &payee,
        Some(&fee_to),
        1,
    );
    env.send(&solver.key, &[ed25519_ix(&attestor, &msg), fill], &[])?;
    assert_eq!(
        env.balance(&judge_ata)?,
        JF,
        "the judge is paid exactly its fee"
    );
    assert!(
        env.balance(&partner_ata)? > 0,
        "the partner earns its share"
    );
    assert_eq!(env.balance(&vault_pda(&intent))?, 0, "the vault is drained");
    assert_eq!(
        JF + env.balance(&payee)?
            + env.balance(&partner_ata)?
            + (env.balance(&fee_to)? - fee_to_before),
        ESCROW,
        "nothing is minted or lost across judge, partner, worker and protocol"
    );
    Ok(())
}

#[test]
fn a_one_lamport_judge_fee_is_still_paid_and_conserves() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    let attestor = Keypair::new();
    const SPEC: [u8; 32] = [0x7a; 32];
    const JF: u64 = 1;
    let spec = IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: ESCROW,
            min_result: 1,
            max_result: 1,
            attestor: attestor.pubkey().to_bytes(),
            spec_hash: SPEC,
            judge_fee: JF,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ..swap_spec(0, ESCROW)?
    };
    env.create_intent(&trader, &market, &spec)?;
    let intent = intent_pda(&owner, 0);
    assert_eq!(
        env.balance(&vault_pda(&intent))?,
        ESCROW,
        "the escrow holds amount_in, not amount_in+fee"
    );
    let solver = env.solver(&market, 0)?;
    let fee_to = env.fee_account(&market)?;
    let payee = solver.input;
    let judge_ata = env.create_ata(&attestor.pubkey(), &market.input_mint, market.input_program)?;
    let delivery = env.announce_for(&solver.key, &intent)?;
    let msg = attestation_proof_message(
        DOMAIN,
        &attestor.pubkey(),
        &intent,
        &payee,
        ESCROW,
        1,
        SPEC,
        &delivery,
    );

    let fee_before = env.balance(&fee_to)?;
    env.judge_to = Some(judge_ata);
    let fill = env.fill_attested_ix(
        &solver.key.pubkey(),
        &owner,
        &market,
        0,
        &payee,
        Some(&fee_to),
        1,
    );
    env.send(&solver.key, &[ed25519_ix(&attestor, &msg), fill], &[])?;
    let judge_paid = env.balance(&judge_ata)?;
    let worker_paid = env.balance(&payee)?;
    let protocol = env.balance(&fee_to)? - fee_before;
    assert_eq!(judge_paid, 1, "the judge is paid its 1-lamport fee");
    assert_eq!(env.balance(&vault_pda(&intent))?, 0, "the vault is drained");
    assert_eq!(
        judge_paid + worker_paid + protocol,
        ESCROW,
        "nothing is minted or lost"
    );
    Ok(())
}

#[test]
fn a_one_lamport_partner_fee_is_still_paid_and_conserves() -> TestResult {
    let (mut env, market, trader) = setup()?;
    let owner = trader.key.pubkey();
    let attestor = Keypair::new();
    let partner = Pubkey::new_unique();
    const SPEC: [u8; 32] = [0x3c; 32];
    const JF: u64 = 40;
    const PARTNER_BPS: u16 = 25;
    let spec = IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: ESCROW,
            min_result: 1,
            max_result: 1,
            attestor: attestor.pubkey().to_bytes(),
            spec_hash: SPEC,
            judge_fee: JF,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ext: partner_ext(&partner, PARTNER_BPS),
        ..swap_spec(0, ESCROW)?
    };
    env.create_intent(&trader, &market, &spec)?;
    let intent = intent_pda(&owner, 0);
    assert_eq!(
        env.balance(&vault_pda(&intent))?,
        ESCROW,
        "the escrow holds amount_in, not amount_in+fee"
    );
    let solver = env.solver(&market, 0)?;
    let fee_to = env.fee_account(&market)?;
    let payee = solver.input;
    let judge_ata = env.create_ata(&attestor.pubkey(), &market.input_mint, market.input_program)?;
    let partner_ata = env.create_ata(&partner, &market.input_mint, market.input_program)?;
    env.judge_to = Some(judge_ata);
    env.partner_to = Some(partner_ata);
    let fee_to_before = env.balance(&fee_to)?;
    let delivery = env.announce_for(&solver.key, &intent)?;
    let msg = attestation_proof_message(
        DOMAIN,
        &attestor.pubkey(),
        &intent,
        &payee,
        ESCROW,
        1,
        SPEC,
        &delivery,
    );
    let fill = env.fill_attested_ix(
        &solver.key.pubkey(),
        &owner,
        &market,
        0,
        &payee,
        Some(&fee_to),
        1,
    );
    env.send(&solver.key, &[ed25519_ix(&attestor, &msg), fill], &[])?;
    assert_eq!(
        env.balance(&judge_ata)?,
        JF,
        "the judge is paid exactly its fee"
    );
    assert_eq!(
        env.balance(&partner_ata)?,
        1,
        "a one-lamport partner share is still paid"
    );
    assert_eq!(env.balance(&vault_pda(&intent))?, 0, "the vault is drained");
    assert_eq!(
        JF + env.balance(&payee)?
            + env.balance(&partner_ata)?
            + (env.balance(&fee_to)? - fee_to_before),
        ESCROW,
        "nothing is minted or lost across judge, partner, worker and protocol"
    );
    Ok(())
}
