use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use anchor_lang::Discriminator;
use intent_core::kinds::{swap_exact_in, Kind};
use intent_engine::errors::EngineError;
use intent_engine::events::{CapsRequiredSet, MintCapSet};
use intent_engine::state::{MintCap, MINT_CAP_SEED};
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    agent_lane, anchor_error, config_pda, ed25519_ix, engine_error, engine_error_at, engine_ix,
    event_authority, events, intent_pda, load, mandate_pda, mandate_terms, pda, swap_spec,
    vault_pda, Env, IntentSpec, Market, TestResult, Trader, DOMAIN, START_TS,
};

const PROGRAM: Pubkey = anchor_spl::token::ID;
const FUNDED: u64 = 1_000_000;
const MAX: u64 = 1_000;
const WINDOW: u64 = 2_500;
const SECS: u32 = 3_600;
const LATER: i64 = START_TS + 86_400;

type Sent = Result<litesvm::types::TransactionMetadata, TransactionError>;

struct World {
    env: Env,
    market: Market,
    trader: Trader,
}

fn world() -> TestResult<World> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(PROGRAM, &[], PROGRAM, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    Ok(World {
        env,
        market,
        trader,
    })
}

fn mint_cap_pda(mint: &Pubkey) -> Pubkey {
    pda(&[MINT_CAP_SEED, mint.as_ref()])
}

fn set_mint_cap_ix(
    admin: &Pubkey,
    payer: &Pubkey,
    mint: &Pubkey,
    max_per_order: u64,
    window_cap: u64,
    window_secs: u32,
) -> Instruction {
    engine_ix(
        intent_engine::accounts::SetMintCap {
            admin: *admin,
            payer: *payer,
            config: config_pda(),
            mint: *mint,
            mint_cap: mint_cap_pda(mint),
            system_program: anchor_lang::system_program::ID,
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::SetMintCap {
            max_per_order,
            window_cap,
            window_secs,
            total_limit: 0,
        },
    )
}

fn set_caps_required_ix(admin: &Pubkey, required: bool) -> Instruction {
    engine_ix(
        intent_engine::accounts::SetCapsRequired {
            admin: *admin,
            config: config_pda(),
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::SetCapsRequired { required },
    )
}

fn spec(nonce: u64, amount: u64) -> TestResult<IntentSpec> {
    Ok(IntentSpec {
        expires_at: LATER,
        ..swap_spec(nonce, amount)?
    })
}

impl World {
    fn admin(&self) -> Keypair {
        self.env.authority.insecure_clone()
    }

    fn cap(&self) -> Pubkey {
        mint_cap_pda(&self.market.input_mint)
    }

    fn set_cap(&mut self, max_per_order: u64, window_cap: u64, window_secs: u32) -> Sent {
        let admin = self.admin();
        let mint = self.market.input_mint;
        let ix = set_mint_cap_ix(
            &admin.pubkey(),
            &admin.pubkey(),
            &mint,
            max_per_order,
            window_cap,
            window_secs,
        );
        self.env.send(&admin, &[ix], &[])
    }

    fn require_caps(&mut self, required: bool) -> Sent {
        let admin = self.admin();
        let ix = set_caps_required_ix(&admin.pubkey(), required);
        self.env.send(&admin, &[ix], &[])
    }

    fn create(&mut self, nonce: u64, amount: u64, cap: Option<Pubkey>) -> TestResult<Sent> {
        self.env.mint_cap = cap;
        let ix = self
            .env
            .create_intent_ix(&self.trader, &self.market, &spec(nonce, amount)?);
        let key = self.trader.key.insecure_clone();
        Ok(self.env.send(&key, &[ix], &[]))
    }

    fn mint_cap(&self) -> TestResult<MintCap> {
        load(&self.env.svm, &self.cap())
    }
}

#[test]
fn a_create_above_the_per_order_cap_is_refused() -> TestResult {
    let mut w = world()?;
    w.set_cap(MAX, WINDOW, SECS)?;
    w.require_caps(true)?;
    let cap = w.cap();
    assert_eq!(
        w.create(0, MAX + 1, Some(cap))?.err(),
        Some(engine_error(EngineError::MintCapPerOrder))
    );
    assert!(!w.env.exists(&intent_pda(&w.trader.key.pubkey(), 0)));
    w.create(0, MAX, Some(cap))??;
    let vault = vault_pda(&intent_pda(&w.trader.key.pubkey(), 0));
    assert_eq!(w.env.balance(&vault)?, MAX);
    assert_eq!(w.env.balance(&w.trader.input)?, FUNDED - MAX);
    assert_eq!(w.mint_cap()?.window_used, MAX);
    Ok(())
}

#[test]
fn creates_beyond_the_window_cap_are_refused_until_the_window_rolls() -> TestResult {
    let mut w = world()?;
    w.set_cap(MAX, WINDOW, SECS)?;
    w.require_caps(true)?;
    let cap = w.cap();
    w.create(0, MAX, Some(cap))??;
    w.create(1, MAX, Some(cap))??;
    assert_eq!(
        w.create(2, MAX, Some(cap))?.err(),
        Some(engine_error(EngineError::MintCapWindow))
    );
    w.create(2, WINDOW - 2 * MAX, Some(cap))??;
    assert_eq!(w.mint_cap()?.window_used, WINDOW);
    assert_eq!(
        w.create(3, 1, Some(cap))?.err(),
        Some(engine_error(EngineError::MintCapWindow))
    );
    w.env.set_now(START_TS + i64::from(SECS) - 1);
    assert_eq!(
        w.create(3, 1, Some(cap))?.err(),
        Some(engine_error(EngineError::MintCapWindow))
    );
    let rolled = START_TS + i64::from(SECS);
    w.env.set_now(rolled);
    w.create(3, MAX, Some(cap))??;
    let state = w.mint_cap()?;
    assert_eq!(state.window_start, rolled);
    assert_eq!(state.window_used, MAX);
    assert_eq!(w.env.balance(&w.trader.input)?, FUNDED - WINDOW - MAX);
    Ok(())
}

#[test]
fn with_caps_required_a_create_without_its_mint_cap_is_refused() -> TestResult {
    let mut w = world()?;
    w.require_caps(true)?;
    assert_eq!(w.env.config()?.caps_required, 1);
    assert_eq!(
        w.create(0, 10, None)?.err(),
        Some(engine_error(EngineError::MintCapMissing))
    );
    let cap = w.cap();
    assert!(!w.env.exists(&cap));
    assert_eq!(
        w.create(0, 10, Some(cap))?.err(),
        Some(anchor_error(ErrorCode::AccountOwnedByWrongProgram))
    );
    w.set_cap(MAX, WINDOW, SECS)?;
    assert_eq!(
        w.create(0, 10, None)?.err(),
        Some(engine_error(EngineError::MintCapMissing))
    );
    w.create(0, 10, Some(cap))??;
    w.require_caps(false)?;
    assert_eq!(w.env.config()?.caps_required, 0);
    w.create(1, 10, None)??;
    Ok(())
}

#[test]
fn every_create_path_enforces_the_mint_cap() -> TestResult {
    const AGENT_FEE: u64 = 5;
    let mut w = world()?;
    w.set_cap(100, 10_000, SECS)?;
    w.require_caps(true)?;
    let cap = w.cap();
    let owner = w.trader.key.pubkey();
    let key = w.trader.key.insecure_clone();
    let relayer = w.env.funded()?;
    let agent = w.env.funded()?;
    w.env.approve_delegate(&w.trader, &w.market, 100_000)?;
    let args = intent_engine::MandateArgs {
        agent_fee: AGENT_FEE,
        ..mandate_terms(agent.pubkey(), LATER)
    };
    let ix = w.env.create_mandate_ix(&w.trader, &w.market, args);
    w.env.send(&key, &[ix], &[])?;
    let mandate = mandate_pda(&owner, &agent.pubkey(), args.id);

    let mut used = 0;
    for (n, (amount, attach, want)) in (0u64..).zip([
        (10, false, Some(EngineError::MintCapMissing)),
        (101, true, Some(EngineError::MintCapPerOrder)),
        (100, true, None),
    ]) {
        let check = |got: Sent, at: u8| match want {
            Some(e) => assert_eq!(got.err(), Some(engine_error_at(at, e)), "{amount}"),
            None => assert!(got.is_ok(), "{amount}: {got:?}"),
        };
        w.env.mint_cap = attach.then_some(cap);

        let ix = w
            .env
            .create_intent_ix(&w.trader, &w.market, &spec(n, amount)?);
        check(w.env.send(&key, &[ix], &[]), 0);

        let signed = spec(10 + n, amount)?;
        let message = w
            .env
            .signed_message(&w.trader, &w.market, &signed, DOMAIN, LATER);
        let ixs = [
            ed25519_ix(&key, &message),
            w.env
                .create_signed_ix(&relayer.pubkey(), &w.trader, &w.market, &signed, LATER),
        ];
        check(w.env.send(&relayer, &ixs, &[]), 1);

        let sold = amount - AGENT_FEE;
        let agent_spec = IntentSpec {
            nonce: agent_lane(1, n),
            kind: Kind::SwapExactIn as u8,
            params: swap_exact_in::Params {
                amount_in: sold,
                min_out: 2 * sold,
            }
            .encode()
            .map_err(|e| format!("{e:?}"))?,
            expires_at: START_TS + 3_600,
            flags: 0,
            ext: Vec::new(),
        };
        let ix = w
            .env
            .agent_intent_ix(&agent.pubkey(), mandate, &w.trader, &w.market, &agent_spec);
        check(w.env.send(&agent, &[ix], &[]), 0);
        if want.is_none() {
            used += 3 * amount;
        }
        assert_eq!(w.mint_cap()?.window_used, used);
    }
    assert_eq!(used, 300);
    assert_eq!(w.env.balance(&w.trader.input)?, FUNDED - used);
    Ok(())
}

#[test]
fn a_mint_cap_of_another_mint_or_owner_is_refused() -> TestResult {
    let mut w = world()?;
    let other = w.env.market(PROGRAM, &[], PROGRAM, &[])?;
    w.set_cap(MAX, WINDOW, SECS)?;
    let admin = w.admin();
    let ix = set_mint_cap_ix(
        &admin.pubkey(),
        &admin.pubkey(),
        &other.input_mint,
        MAX,
        WINDOW,
        SECS,
    );
    w.env.send(&admin, &[ix], &[])?;
    w.require_caps(true)?;
    let seeds = Some(anchor_error(ErrorCode::ConstraintSeeds));
    let foreign = mint_cap_pda(&other.input_mint);
    assert_eq!(w.create(0, 10, Some(foreign))?.err(), seeds);

    let real = w.env.svm.get_account(&w.cap()).ok_or("mint cap missing")?;
    let copy = Pubkey::new_unique();
    w.env.svm.set_account(copy, real.clone())?;
    assert_eq!(w.create(0, 10, Some(copy))?.err(), seeds);
    let stranger = Pubkey::new_unique();
    let mut owned = real.clone();
    owned.owner = Pubkey::new_unique();
    w.env.svm.set_account(stranger, owned)?;
    assert_eq!(
        w.create(0, 10, Some(stranger))?.err(),
        Some(anchor_error(ErrorCode::AccountOwnedByWrongProgram))
    );
    let mut wrong_type = real;
    let data = wrong_type.data.get_mut(..8).ok_or("short")?;
    data.copy_from_slice(&[0; 8]);
    let retyped = Pubkey::new_unique();
    w.env.svm.set_account(retyped, wrong_type)?;
    assert_eq!(
        w.create(0, 10, Some(retyped))?.err(),
        Some(anchor_error(ErrorCode::AccountDiscriminatorMismatch))
    );

    w.env.mint_cap = Some(w.cap());
    let mut ix = w.env.create_intent_ix(&w.trader, &w.market, &spec(0, 10)?);
    let cap = w.cap();
    for meta in ix.accounts.iter_mut().filter(|m| m.pubkey == cap) {
        meta.is_writable = false;
    }
    let key = w.trader.key.insecure_clone();
    assert_eq!(
        w.env.send(&key, &[ix], &[]).err(),
        Some(anchor_error(ErrorCode::ConstraintMut))
    );

    w.create(0, 10, Some(cap))??;
    assert_eq!(w.mint_cap()?.window_used, 10);
    let foreign_state: MintCap = load(&w.env.svm, &foreign)?;
    assert_eq!(foreign_state.window_used, 0);
    Ok(())
}

#[test]
fn a_mint_cap_that_names_another_mint_is_refused() -> TestResult {
    let mut w = world()?;
    w.set_cap(MAX, WINDOW, SECS)?;
    w.require_caps(true)?;
    let cap = w.cap();
    let mut account = w.env.svm.get_account(&cap).ok_or("mint cap missing")?;
    let mut state: MintCap = load(&w.env.svm, &cap)?;
    state.mint = Pubkey::new_unique();
    account
        .data
        .get_mut(8..MintCap::SPACE)
        .ok_or("mint cap too short")?
        .copy_from_slice(bytemuck::bytes_of(&state));
    w.env.svm.set_account(cap, account)?;
    assert_eq!(
        w.create(0, 10, Some(cap))?.err(),
        Some(engine_error(EngineError::MintCapMismatch))
    );
    assert!(!w.env.exists(&intent_pda(&w.trader.key.pubkey(), 0)));
    assert_eq!(w.mint_cap()?.window_used, 0);
    Ok(())
}

#[test]
fn only_the_admin_sets_a_mint_cap_or_requires_caps() -> TestResult {
    let mut w = world()?;
    let stranger = w.env.funded()?;
    let mint = w.market.input_mint;
    let ix = set_mint_cap_ix(
        &stranger.pubkey(),
        &stranger.pubkey(),
        &mint,
        MAX,
        WINDOW,
        SECS,
    );
    assert_eq!(
        w.env.send(&stranger, &[ix], &[]).err(),
        Some(engine_error(EngineError::Unauthorized))
    );
    let ix = set_caps_required_ix(&stranger.pubkey(), true);
    assert_eq!(
        w.env.send(&stranger, &[ix], &[]).err(),
        Some(engine_error(EngineError::Unauthorized))
    );
    assert!(!w.env.exists(&w.cap()));
    assert_eq!(w.env.config()?.caps_required, 0);

    let admin = w.admin();
    let payer = w.env.funded()?;
    let before = w.env.lamports(&admin.pubkey());
    let ix = set_mint_cap_ix(&admin.pubkey(), &payer.pubkey(), &mint, MAX, WINDOW, SECS);
    let meta = w.env.send(&payer, &[ix], &[&admin])?;
    assert_eq!(w.env.lamports(&admin.pubkey()), before);
    let state = w.mint_cap()?;
    assert_eq!(state.mint, mint);
    assert_eq!(
        (state.max_per_order, state.window_cap, state.window_secs),
        (MAX, WINDOW, SECS)
    );
    assert_eq!((state.window_start, state.window_used), (START_TS, 0));
    let account = w.env.svm.get_account(&w.cap()).ok_or("mint cap missing")?;
    assert_eq!(account.owner, intent_engine::ID);
    assert_eq!(account.data.len(), MintCap::SPACE);
    assert_eq!(account.data.get(..8), Some(MintCap::DISCRIMINATOR));
    let set = events::<MintCapSet>(&meta);
    assert_eq!(set.len(), 1);
    let event = set.first().ok_or("no event")?;
    assert_eq!(
        (
            event.mint,
            event.mint_cap,
            event.max_per_order,
            event.window_cap,
            event.window_secs
        ),
        (mint, w.cap(), MAX, WINDOW, SECS)
    );

    let meta = w
        .env
        .send(&admin, &[set_caps_required_ix(&admin.pubkey(), true)], &[])?;
    assert_eq!(w.env.config()?.caps_required, 1);
    let required = events::<CapsRequiredSet>(&meta);
    assert_eq!(required.len(), 1);
    assert!(required.first().ok_or("no event")?.required);
    Ok(())
}

#[test]
fn a_mint_cap_refuses_invalid_limits() -> TestResult {
    let mut w = world()?;
    let invalid = Some(engine_error(EngineError::MintCapInvalid));
    assert_eq!(w.set_cap(0, WINDOW, SECS).err(), invalid);
    assert_eq!(w.set_cap(MAX, MAX - 1, SECS).err(), invalid);
    assert_eq!(w.set_cap(MAX, WINDOW, 59).err(), invalid);
    assert!(!w.env.exists(&w.cap()));
    w.set_cap(MAX, MAX, 60)?;
    assert_eq!(w.set_cap(0, WINDOW, SECS).err(), invalid);
    assert_eq!(w.set_cap(WINDOW + 1, WINDOW, SECS).err(), invalid);
    assert_eq!(w.set_cap(MAX, WINDOW, 0).err(), invalid);
    let state = w.mint_cap()?;
    assert_eq!(
        (state.max_per_order, state.window_cap, state.window_secs),
        (MAX, MAX, 60)
    );
    Ok(())
}

#[test]
fn without_caps_required_a_create_without_remaining_accounts_still_works() -> TestResult {
    let mut w = world()?;
    let ix = w
        .env
        .create_intent_ix(&w.trader, &w.market, &spec(0, 50_000)?);
    let slots: Vec<Pubkey> = ix.accounts.iter().map(|m| m.pubkey).collect();
    assert_eq!(
        slots.get(slots.len().saturating_sub(3)),
        Some(&intent_engine::ID)
    );
    w.create(0, 50_000, None)??;
    w.set_cap(MAX, WINDOW, SECS)?;
    assert_eq!(w.env.config()?.caps_required, 0);
    w.create(1, 50_000, None)??;
    let cap = w.cap();
    w.create(2, 50_000, Some(cap))??;
    assert_eq!(w.mint_cap()?.window_used, 0);
    assert_eq!(w.env.balance(&w.trader.input)?, FUNDED - 150_000);
    Ok(())
}

#[test]
fn updating_a_mint_cap_keeps_its_window() -> TestResult {
    let mut w = world()?;
    w.set_cap(MAX, WINDOW, SECS)?;
    w.require_caps(true)?;
    let cap = w.cap();
    w.create(0, MAX, Some(cap))??;
    w.env.set_now(START_TS + 100);
    w.set_cap(2 * MAX, 2 * WINDOW, 2 * SECS)?;
    let state = w.mint_cap()?;
    assert_eq!((state.window_start, state.window_used), (START_TS, MAX));
    assert_eq!(
        (state.max_per_order, state.window_cap, state.window_secs),
        (2 * MAX, 2 * WINDOW, 2 * SECS)
    );
    w.create(1, 2 * MAX, Some(cap))??;
    assert_eq!(w.mint_cap()?.window_used, 3 * MAX);
    w.env.set_now(START_TS + i64::from(SECS));
    w.create(2, 2 * MAX, Some(cap))??;
    assert_eq!(w.mint_cap()?.window_used, 5 * MAX);
    w.set_cap(MAX, MAX, 60)?;
    let state = w.mint_cap()?;
    assert_eq!((state.window_start, state.window_used), (START_TS, 5 * MAX));
    let now = START_TS + i64::from(SECS);
    w.create(3, MAX, Some(cap))??;
    let state = w.mint_cap()?;
    assert_eq!((state.window_start, state.window_used), (now, MAX));
    assert_eq!(
        w.create(4, 1, Some(cap))?.err(),
        Some(engine_error(EngineError::MintCapWindow))
    );
    w.env.set_now(now + 60);
    w.create(4, 1, Some(cap))??;
    Ok(())
}
