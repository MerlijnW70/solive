use anchor_lang::prelude::Pubkey;
use intent_core::kinds::{attested_result, dutch_auction, limit_order, swap_exact_in, Kind};
use intent_core::mandate::MANDATE_NONCE_BIT;
use intent_engine::errors::EngineError;
use intent_engine::events::{AgentPaid, IntentCreated, IntentFilled, MandateClosed, MandateCreated, MandateUsed};
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    agent_lane, anchor_error, bump_search_cost, cu_gates, engine_error, events, intent_pda, mandate_pda,
    mandate_terms, partner_ext, vault_pda, Env, IntentSpec, Market, TestResult, Trader, START_TS,
};

const FUNDED: u64 = 1_000;
const ALLOWANCE: u64 = 1_000;
const VALID_UNTIL: i64 = START_TS + 86_400;

struct Setup {
    env: Env,
    market: Market,
    trader: Trader,
    agent: Keypair,
    mandate: Pubkey,
}

fn agent_nonce(n: u64) -> u64 {
    if n & MANDATE_NONCE_BIT == 0 {
        agent_lane(1, n)
    } else {
        n
    }
}

fn swap(n: u64, amount_in: u64, min_out: u64) -> TestResult<IntentSpec> {
    Ok(IntentSpec {
        nonce: agent_nonce(n),
        kind: Kind::SwapExactIn as u8,
        params: swap_exact_in::Params { amount_in, min_out }
            .encode()
            .map_err(|e| format!("{e:?}"))?,
        expires_at: START_TS + 3_600,
        flags: 0,
        ext: Vec::new(),
    })
}

fn with_terms(terms: intent_engine::MandateArgs) -> TestResult<Setup> {
    with_market(terms, &[])
}

fn with_market(terms: intent_engine::MandateArgs, input: &[svm_tests::MintExt]) -> TestResult<Setup> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(PROGRAM, input, PROGRAM, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    env.approve_delegate(&trader, &market, ALLOWANCE)?;
    let agent = env.funded()?;
    let owner = trader.key.insecure_clone();
    let args = intent_engine::MandateArgs { agent: agent.pubkey(), ..terms };
    let ix = env.create_mandate_ix(&trader, &market, args);
    env.send(&owner, &[ix], &[])?;
    let mandate = mandate_pda(&owner.pubkey(), &agent.pubkey(), args.id);
    Ok(Setup {
        env,
        market,
        trader,
        agent,
        mandate,
    })
}

fn setup() -> TestResult<Setup> {
    with_terms(mandate_terms(Pubkey::default(), VALID_UNTIL))
}

impl Setup {
    fn owner(&self) -> Pubkey {
        self.trader.key.pubkey()
    }

    fn by_agent(&self, spec: &IntentSpec) -> Instruction {
        self.env
            .agent_intent_ix(&self.agent.pubkey(), self.mandate, &self.trader, &self.market, spec)
    }

    fn agent_sends(&mut self, ixs: &[Instruction]) -> Result<litesvm::types::TransactionMetadata, TransactionError> {
        let agent = self.agent.insecure_clone();
        self.env.send(&agent, ixs, &[])
    }

    fn agent_creates(&mut self, spec: &IntentSpec) -> Result<litesvm::types::TransactionMetadata, TransactionError> {
        let ix = self.by_agent(spec);
        self.agent_sends(&[ix])
    }

    fn owner_sends(&mut self, ixs: &[Instruction]) -> Result<litesvm::types::TransactionMetadata, TransactionError> {
        let owner = self.trader.key.insecure_clone();
        self.env.send(&owner, ixs, &[])
    }
}

#[test]
fn an_owner_grants_a_mandate_once_and_its_terms_are_stored() -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(PROGRAM, &[], PROGRAM, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let owner = trader.key.insecure_clone();
    let agent = Pubkey::new_unique();
    let partner = Pubkey::new_unique();
    let args = intent_engine::MandateArgs {
        id: 9,
        partner,
        partner_bps: 100,
        ..mandate_terms(agent, VALID_UNTIL)
    };
    let before = env.lamports(&owner.pubkey());
    let ix = env.create_mandate_ix(&trader, &market, args);
    let meta = env.send(&owner, &[ix], &[])?;
    let address = mandate_pda(&owner.pubkey(), &agent, 9);
    let m = env.mandate(&address)?;
    assert_eq!((m.owner, m.agent, m.id, m.epoch), (owner.pubkey(), agent, 9, 0));
    assert_eq!((m.input_mint, m.output_mint), (market.input_mint, market.output_mint));
    assert_eq!((m.partner, m.partner_bps), (partner, 100));
    assert_eq!((m.input_account, m.output_account), (trader.input, trader.receiver));
    assert_eq!((m.kinds, m.per_intent, m.total, m.max_intents), (0b1110, 400, 1_000, 4));
    assert_eq!((m.max_ttl, m.valid_until, m.floor_out, m.floor_in), (3_600, VALID_UNTIL, 1, 2));
    assert_eq!((m.spent, m.intents, m.version), (0, 0, intent_engine::state::MANDATE_VERSION));
    assert_eq!(m.bump, Pubkey::find_program_address(&[b"mandate", owner.pubkey().as_ref(), agent.as_ref(), &9u64.to_le_bytes()], &intent_engine::ID).1);
    assert!(env.lamports(&owner.pubkey()) < before);
    let created = events::<MandateCreated>(&meta).pop().ok_or("missing event")?;
    assert_eq!(
        (created.mandate, created.owner, created.agent, created.id, created.epoch),
        (address, owner.pubkey(), agent, 9, 0)
    );
    assert_eq!((created.input_mint, created.output_mint), (market.input_mint, market.output_mint));
    assert_eq!((created.kinds, created.per_intent, created.total, created.max_intents), (0b1110, 400, 1_000, 4));
    assert_eq!((created.max_ttl, created.valid_until, created.floor_out, created.floor_in), (3_600, VALID_UNTIL, 1, 2));
    assert_eq!((created.partner, created.partner_bps), (partner, 100));
    assert_eq!((created.input_account, created.output_account), (trader.input, trader.receiver));
    assert_eq!((created.serial, m.serial), (1, 1));
    Ok(())
}

#[test]
fn an_agent_intent_cannot_fill_while_its_owners_state_has_an_unknown_version() -> TestResult {
    let mut s = setup()?;
    s.agent_creates(&swap(0, 10, 5)?)?;
    let user = svm_tests::user_pda(&s.owner());
    let mut account = s.env.svm.get_account(&user).ok_or("user missing")?;
    assert_eq!(account.data.get(8 + 72).copied(), Some(intent_engine::state::USER_VERSION));
    *account.data.get_mut(8 + 72).ok_or("short")? = 2;
    s.env.svm.set_account(user, account)?;
    assert_eq!(s.fill(0), Err(engine_error(EngineError::UnsupportedVersion)));
    assert_eq!(s.begin(0), Err(engine_error(EngineError::UnsupportedVersion)));
    Ok(())
}

const USER_VERSION_AT: usize = 8 + 72;
const CONFIG_VERSION_AT: usize = 8 + 139;

fn set_byte(env: &mut Env, key: &Pubkey, at: usize, value: u8) -> TestResult {
    let mut account = env.svm.get_account(key).ok_or("account missing")?;
    *account.data.get_mut(at).ok_or("short")? = value;
    env.svm.set_account(*key, account)?;
    Ok(())
}

#[test]
fn agents_and_grants_refuse_an_unknown_user_or_config_version() -> TestResult {
    let mut s = setup()?;
    let user = svm_tests::user_pda(&s.owner());
    set_byte(&mut s.env, &user, USER_VERSION_AT, 2)?;
    assert_eq!(s.agent_creates(&swap(0, 10, 5)?), Err(engine_error(EngineError::UnsupportedVersion)));
    let args = intent_engine::MandateArgs { id: 1, ..mandate_terms(s.agent.pubkey(), VALID_UNTIL) };
    let grant = s.env.create_mandate_ix(&s.trader, &s.market, args);
    assert_eq!(s.owner_sends(&[grant]), Err(engine_error(EngineError::UnsupportedVersion)));
    set_byte(&mut s.env, &user, USER_VERSION_AT, intent_engine::state::USER_VERSION)?;
    set_byte(&mut s.env, &svm_tests::config_pda(), CONFIG_VERSION_AT, 2)?;
    assert_eq!(s.agent_creates(&swap(0, 10, 5)?), Err(engine_error(EngineError::UnsupportedVersion)));
    set_byte(&mut s.env, &svm_tests::config_pda(), CONFIG_VERSION_AT, intent_engine::state::CONFIG_VERSION)?;
    s.agent_creates(&swap(0, 10, 5)?)?;
    Ok(())
}

#[test]
fn an_agent_escrows_the_crank_bounty_it_pays_for() -> TestResult {
    const BOUNTY: u32 = 70_000;
    let mut s = setup()?;
    let admin = s.env.authority.insecure_clone();
    let economics = intent_engine::Economics {
        kind_fee_mask: 0,
        kind_fee_bps: [0; 4],
        partner_cut_bps: 0,
        crank_bounty: BOUNTY,
        create_fee: 0,
    };
    let ix = s.env.economics_ix(&admin.pubkey(), economics);
    s.env.send(&admin, &[ix], &[])?;
    let meta = s.agent_creates(&swap(0, 10, 5)?)?;
    let intent = intent_pda(&s.owner(), agent_nonce(0));
    let rent = s.env.svm.minimum_balance_for_rent_exemption(intent_engine::state::Intent::SPACE);
    assert_eq!(Some(s.env.lamports(&intent)), rent.checked_add(u64::from(BOUNTY)));
    assert_eq!(s.env.intent(&s.owner(), agent_nonce(0))?.bounty, BOUNTY);
    assert_eq!(events::<IntentCreated>(&meta).pop().ok_or("missing")?.bounty, BOUNTY);
    Ok(())
}

#[test]
fn a_flash_fill_pays_only_the_agents_canonical_account_and_reads_only_the_owners_state() -> TestResult {
    let mut s = with_terms(intent_engine::MandateArgs {
        agent_fee: 10,
        ..mandate_terms(Pubkey::default(), VALID_UNTIL)
    })?;
    let agent = s.agent.pubkey();
    s.agent_creates(&swap(0, 390, 200)?)?;
    let canonical = s.env.create_ata(&agent, &s.market.input_mint, s.market.input_program)?;
    let foreign = s.env.create_token_account(&s.market.input_mint, &agent, s.market.input_program)?;
    s.env.agent_to = Some(Some(foreign));
    assert_eq!(s.begin(0), Err(engine_error(EngineError::FeeAccountNotCanonical)));
    s.env.agent_to = None;
    let stranger = s.env.trader(&s.market, 1)?;
    s.env.mandate_accounts = Some((Some(s.mandate), Some(svm_tests::user_pda(&stranger.key.pubkey()))));
    assert_eq!(s.begin(0), Err(engine_error(EngineError::MandateMismatch)));
    s.env.mandate_accounts = None;
    s.begin(0)?;
    assert_eq!(s.env.balance(&canonical)?, 10);
    Ok(())
}

const MANDATE_VERSION_AT: usize = 8 + 7 * 32 + 9 * 8 + 2 * 4 + 2 + 1;

#[test]
fn an_unknown_mandate_version_admits_and_fills_nothing_and_still_revokes() -> TestResult {
    for version in [0u8, 2, u8::MAX] {
        let mut s = setup()?;
        s.agent_creates(&swap(0, 10, 5)?)?;
        let mut account = s.env.svm.get_account(&s.mandate).ok_or("mandate missing")?;
        assert_eq!(account.data.get(MANDATE_VERSION_AT).copied(), Some(intent_engine::state::MANDATE_VERSION));
        *account.data.get_mut(MANDATE_VERSION_AT).ok_or("short")? = version;
        s.env.svm.set_account(s.mandate, account)?;
        assert_eq!(
            s.agent_creates(&swap(1, 10, 5)?),
            Err(engine_error(EngineError::UnsupportedVersion)),
            "version {version}"
        );
        assert_eq!(s.fill(0), Err(engine_error(EngineError::UnsupportedVersion)), "version {version}");
        assert_eq!(s.begin(0), Err(engine_error(EngineError::UnsupportedVersion)), "version {version}");
        s.revoke()?;
        assert!(!s.env.exists(&s.mandate));
    }
    Ok(())
}

#[test]
fn the_mandate_records_the_owners_current_signing_epoch() -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(PROGRAM, &[], PROGRAM, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let owner = trader.key.insecure_clone();
    let bump = env.advance_epoch_ix(&owner.pubkey(), 77);
    env.send(&owner, &[bump], &[])?;
    let agent = Pubkey::new_unique();
    let ix = env.create_mandate_ix(&trader, &market, mandate_terms(agent, VALID_UNTIL));
    env.send(&owner, &[ix], &[])?;
    assert_eq!(env.mandate(&mandate_pda(&owner.pubkey(), &agent, 0))?.epoch, 77);
    Ok(())
}

#[test]
fn unsound_mandates_are_refused() -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(PROGRAM, &[], PROGRAM, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let owner = trader.key.insecure_clone();
    let agent = Pubkey::new_unique();
    let base = mandate_terms(agent, VALID_UNTIL);
    let cases = [
        (intent_engine::MandateArgs { kinds: 0b1_1110, ..base }, EngineError::MandateInvalid),
        (intent_engine::MandateArgs { valid_until: START_TS, ..base }, EngineError::MandateInvalid),
        (intent_engine::MandateArgs { total: 399, ..base }, EngineError::MandateInvalid),
        (intent_engine::MandateArgs { agent: Pubkey::default(), ..base }, EngineError::MandateInvalid),
        (intent_engine::MandateArgs { agent: owner.pubkey(), ..base }, EngineError::MandateInvalid),
        (intent_engine::MandateArgs { partner_bps: 5, ..base }, EngineError::MandateInvalid),
        (intent_engine::MandateArgs { partner: Pubkey::new_unique(), ..base }, EngineError::MandateInvalid),
        (
            intent_engine::MandateArgs { partner: Pubkey::new_unique(), partner_bps: 101, ..base },
            EngineError::MandateInvalid,
        ),
    ];
    for (args, error) in cases {
        let ix = env.create_mandate_ix(&trader, &market, args);
        assert_eq!(env.send(&owner, &[ix], &[]), Err(engine_error(error)), "{args:?}");
    }
    let same = Market {
        input_mint: market.input_mint,
        output_mint: market.input_mint,
        input_program: market.input_program,
        output_program: market.input_program,
    };
    let one_mint = Trader {
        key: trader.key.insecure_clone(),
        input: trader.input,
        receiver: trader.input,
        receiver_authority: trader.receiver_authority,
    };
    let ix = env.create_mandate_ix(&one_mint, &same, base);
    assert_eq!(env.send(&owner, &[ix], &[]), Err(engine_error(EngineError::SameMint)));
    let stranger = env.funded()?;
    let unregistered = Trader {
        key: stranger.insecure_clone(),
        input: trader.input,
        receiver: trader.receiver,
        receiver_authority: stranger.pubkey(),
    };
    let ix = env.create_mandate_ix(&unregistered, &market, base);
    assert_eq!(
        env.send(&stranger, &[ix], &[]),
        Err(anchor_error(anchor_lang::error::ErrorCode::AccountOwnedByWrongProgram))
    );
    Ok(())
}

#[test]
fn proceeds_may_only_be_pinned_to_an_account_no_one_else_controls() -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(PROGRAM, &[], PROGRAM, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let owner = trader.key.insecure_clone();
    let outsider = Pubkey::new_unique();
    let approve = anchor_spl::token_2022::spl_token_2022::instruction::approve(
        &PROGRAM,
        &trader.receiver,
        &outsider,
        &owner.pubkey(),
        &[],
        1,
    )?;
    env.send(&owner, &[approve], &[])?;
    let ix = env.create_mandate_ix(&trader, &market, mandate_terms(Pubkey::new_unique(), VALID_UNTIL));
    assert_eq!(env.send(&owner, &[ix], &[]), Err(engine_error(EngineError::ReceiverNotAllowed)));
    let revoke = anchor_spl::token_2022::spl_token_2022::instruction::revoke(&PROGRAM, &trader.receiver, &owner.pubkey(), &[])?;
    env.send(&owner, &[revoke], &[])?;
    let ix = env.create_mandate_ix(&trader, &market, mandate_terms(Pubkey::new_unique(), VALID_UNTIL));
    env.send(&owner, &[ix], &[])?;
    Ok(())
}

#[test]
fn the_agent_draws_only_from_and_pays_only_into_the_accounts_the_owner_named() -> TestResult {
    let mut s = setup()?;
    let spec = swap(0, 10, 5)?;
    let spare_input = s.env.create_token_account(&s.market.input_mint, &s.owner(), PROGRAM)?;
    s.env.mint_to(&s.market.input_mint, &spare_input, PROGRAM, 100)?;
    let owner = s.trader.key.insecure_clone();
    let approve = anchor_spl::token_2022::spl_token_2022::instruction::approve(
        &PROGRAM,
        &spare_input,
        &svm_tests::delegate_pda(&s.owner()),
        &s.owner(),
        &[],
        100,
    )?;
    s.env.send(&owner, &[approve], &[])?;
    let spare_output = s.env.create_token_account(&s.market.output_mint, &s.owner(), PROGRAM)?;
    for (input, receiver) in [(spare_input, s.trader.receiver), (s.trader.input, spare_output)] {
        let elsewhere = Trader {
            key: s.trader.key.insecure_clone(),
            input,
            receiver,
            receiver_authority: s.owner(),
        };
        let ix = s.env.agent_intent_ix(&s.agent.pubkey(), s.mandate, &elsewhere, &s.market, &spec);
        assert_eq!(s.agent_sends(&[ix]), Err(engine_error(EngineError::MandateMismatch)));
    }
    assert_eq!(s.env.balance(&spare_input)?, 100);
    s.agent_creates(&spec)?;
    Ok(())
}

#[test]
fn the_agent_cannot_name_another_input_mint_even_with_the_owners_own_account() -> TestResult {
    let mut s = setup()?;
    let spec = swap(0, 10, 5)?;
    let other = s.env.market(PROGRAM, &[], PROGRAM, &[])?;
    let forged = Market {
        input_mint: other.input_mint,
        ..s.market
    };
    let ix = s.env.agent_intent_ix(&s.agent.pubkey(), s.mandate, &s.trader, &forged, &spec);
    assert_eq!(s.agent_sends(&[ix]), Err(engine_error(EngineError::MandateMismatch)));
    assert!(!s.env.exists(&intent_pda(&s.owner(), spec.nonce)));
    s.agent_creates(&spec)?;
    Ok(())
}

#[test]
fn the_agent_cannot_name_an_output_mint_or_token_program_the_mandate_did_not() -> TestResult {
    let mut s = setup()?;
    let spec = swap(0, 10, 5)?;
    let wrong_program = if PROGRAM == anchor_spl::token::ID {
        anchor_spl::token_2022::ID
    } else {
        anchor_spl::token::ID
    };
    let other = s.env.market(PROGRAM, &[], PROGRAM, &[])?;
    let mint_program = anchor_error(anchor_lang::error::ErrorCode::ConstraintMintTokenProgram);
    for (forged, refused) in [
        (Market { output_mint: other.output_mint, ..s.market }, engine_error(EngineError::MandateMismatch)),
        (Market { output_program: wrong_program, ..s.market }, mint_program),
    ] {
        let ix = s.env.agent_intent_ix(&s.agent.pubkey(), s.mandate, &s.trader, &forged, &spec);
        assert_eq!(s.agent_sends(&[ix]), Err(refused));
    }
    assert!(!s.env.exists(&intent_pda(&s.owner(), spec.nonce)));
    s.agent_creates(&spec)?;
    Ok(())
}

#[test]
fn the_agent_creates_an_intent_from_the_owners_allowance_and_pays_every_cost_itself() -> TestResult {
    let mut s = setup()?;
    let owner = s.owner();
    let owner_lamports = s.env.lamports(&owner);
    let agent_lamports = s.env.lamports(&s.agent.pubkey());
    let meta = s.agent_creates(&swap(3, 400, 200)?)?;
    let intent = intent_pda(&owner, agent_nonce(3));
    assert_eq!(s.env.balance(&s.trader.input)?, FUNDED - 400);
    assert_eq!(s.env.balance(&vault_pda(&intent))?, 400);
    assert_eq!(s.env.lamports(&owner), owner_lamports);
    assert!(s.env.lamports(&s.agent.pubkey()) < agent_lamports);
    let stored = s.env.intent(&owner, agent_nonce(3))?;
    assert_eq!((stored.owner, stored.rent_payer, stored.receiver), (owner, s.agent.pubkey(), s.trader.receiver));
    let m = s.env.mandate(&s.mandate)?;
    assert_eq!((m.spent, m.intents), (400, 1));
    let created = events::<IntentCreated>(&meta).pop().ok_or("missing")?;
    assert_eq!((created.owner, created.rent_payer, created.escrowed), (owner, s.agent.pubkey(), 400));
    let used = events::<MandateUsed>(&meta).pop().ok_or("missing")?;
    assert_eq!(
        (used.mandate, used.intent, used.agent, used.escrowed, used.spent, used.intents),
        (s.mandate, intent, s.agent.pubkey(), 400, 400, 1)
    );
    s.agent_creates(&swap(4, 300, 150)?)?;
    let m = s.env.mandate(&s.mandate)?;
    assert_eq!((m.spent, m.intents), (700, 2));
    let delegated = s.env.balance(&s.trader.input)?;
    assert_eq!(delegated, FUNDED - 700);
    assert_eq!(s.env.user(&owner)?.nonce_bitmap, [0, 0, 0, 0]);
    Ok(())
}

#[test]
fn agents_use_their_own_nonces_and_never_touch_the_owners_window() -> TestResult {
    let mut s = setup()?;
    let mut low = swap(0, 10, 5)?;
    low.nonce = 5;
    assert_eq!(s.agent_creates(&low), Err(engine_error(EngineError::MandateMismatch)));
    let high = swap(5, 10, 5)?;
    let ix = s.env.create_intent_ix(&s.trader, &s.market, &high);
    assert_eq!(s.owner_sends(&[ix]), Err(engine_error(EngineError::NonceOutOfWindow)));
    let ix = s.env.advance_ix(&s.owner(), MANDATE_NONCE_BIT - 1);
    assert_eq!(s.owner_sends(&[ix]), Err(engine_error(EngineError::NonceJumpTooLarge)));
    let user = svm_tests::user_pda(&s.owner());
    let mut account = s.env.svm.get_account(&user).ok_or("user missing")?;
    let near = intent_core::nonce::NONCE_CEILING - 1;
    account
        .data
        .get_mut(40..48)
        .ok_or("user state too short")?
        .copy_from_slice(&near.to_le_bytes());
    s.env.svm.set_account(user, account)?;
    let ix = s.env.advance_ix(&s.owner(), intent_core::nonce::NONCE_CEILING);
    s.owner_sends(&[ix])?;
    let top = IntentSpec { nonce: MANDATE_NONCE_BIT, ..swap(0, 10, 5)? };
    let ix = s.env.create_intent_ix(&s.trader, &s.market, &top);
    assert_eq!(s.owner_sends(&[ix]), Err(engine_error(EngineError::NonceOutOfWindow)));
    let edge = IntentSpec { nonce: MANDATE_NONCE_BIT - 1, ..swap(0, 10, 5)? };
    let ix = s.env.create_intent_ix(&s.trader, &s.market, &edge);
    s.owner_sends(&[ix])?;
    let window = s.env.user(&s.owner())?;
    s.agent_creates(&swap(0, 10, 5)?)?;
    assert_eq!(s.env.user(&s.owner())?.nonce_bitmap, window.nonce_bitmap);
    assert_eq!(s.agent_creates(&swap(0, 10, 5)?), Err(solana_transaction_error::TransactionError::InstructionError(0, solana_instruction_error::InstructionError::Custom(0))));
    assert_eq!(s.env.mandate(&s.mandate)?.spent, 10);
    Ok(())
}

#[test]
fn every_limit_in_the_mandate_is_enforced() -> TestResult {
    let mut s = setup()?;
    let at = |e: EngineError| Err(engine_error(e));
    assert_eq!(s.agent_creates(&swap(0, 401, 1_000)?), at(EngineError::MandateCap));
    assert_eq!(s.agent_creates(&swap(0, 400, 199)?), at(EngineError::MandatePrice));
    let mut long = swap(0, 10, 5)?;
    long.expires_at = START_TS + 3_601;
    assert_eq!(s.agent_creates(&long), at(EngineError::MandateTtl));
    long.expires_at = START_TS + 3_600;
    s.agent_creates(&long)?;
    let attested = IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: 10,
            min_result: 1,
            max_result: 2,
            attestor: s.agent.pubkey().to_bytes(),
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ..swap(1, 10, 5)?
    };
    assert_eq!(s.agent_creates(&attested), at(EngineError::MandateKind));
    let mut flagged = swap(1, 10, 5)?;
    flagged.flags = 1;
    assert_eq!(s.agent_creates(&flagged), at(EngineError::MandateMismatch));
    let mut partnered = swap(1, 10, 5)?;
    partnered.ext = partner_ext(&s.agent.pubkey(), 50);
    assert_eq!(s.agent_creates(&partnered), at(EngineError::MandateMismatch));
    s.agent_creates(&swap(1, 400, 200)?)?;
    s.agent_creates(&swap(2, 400, 200)?)?;
    assert_eq!(s.agent_creates(&swap(3, 191, 100)?), at(EngineError::MandateBudget));
    s.agent_creates(&swap(3, 190, 95)?)?;
    assert_eq!(s.env.mandate(&s.mandate)?.spent, 1_000);
    Ok(())
}

#[test]
fn the_count_kinds_and_expiry_of_a_mandate_hold() -> TestResult {
    let mut s = with_terms(intent_engine::MandateArgs {
        kinds: 0b100,
        max_intents: 1,
        ..mandate_terms(Pubkey::default(), START_TS + 100)
    })?;
    assert_eq!(s.agent_creates(&swap(0, 10, 5)?), Err(engine_error(EngineError::MandateKind)));
    let limit = IntentSpec {
        kind: Kind::LimitOrder as u8,
        params: limit_order::Params { make_amount: 10, take_amount: 5 }
            .encode()
            .map_err(|e| format!("{e:?}"))?,
        ..swap(0, 10, 5)?
    };
    s.agent_creates(&limit)?;
    let again = IntentSpec { nonce: 1, ..limit };
    assert_eq!(s.agent_creates(&again), Err(engine_error(EngineError::MandateCount)));
    let mut d = with_terms(intent_engine::MandateArgs {
        kinds: 0b1000,
        ..mandate_terms(Pubkey::default(), START_TS + 100)
    })?;
    let dutch = IntentSpec {
        kind: Kind::DutchAuction as u8,
        params: dutch_auction::Params {
            amount_in: 10,
            start_out: 20,
            end_out: 5,
            start_ts: START_TS,
            end_ts: START_TS + 60,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ..swap(0, 10, 5)?
    };
    d.env.set_now(START_TS + 99);
    d.agent_creates(&dutch)?;
    d.env.set_now(START_TS + 100);
    let later = IntentSpec { nonce: 1, expires_at: START_TS + 200, ..dutch };
    assert_eq!(d.agent_creates(&later), Err(engine_error(EngineError::MandateExpired)));
    Ok(())
}

#[test]
fn a_partner_named_by_the_owner_is_the_only_partner_the_agent_may_use() -> TestResult {
    let partner = Pubkey::new_unique();
    let mut s = with_terms(intent_engine::MandateArgs {
        partner,
        partner_bps: 30,
        ..mandate_terms(Pubkey::default(), VALID_UNTIL)
    })?;
    let plain = swap(0, 10, 5)?;
    assert_eq!(s.agent_creates(&plain), Err(engine_error(EngineError::MandateMismatch)));
    let wrong_bps = IntentSpec { ext: partner_ext(&partner, 31), ..swap(0, 10, 5)? };
    assert_eq!(s.agent_creates(&wrong_bps), Err(engine_error(EngineError::MandateMismatch)));
    let wrong_key = IntentSpec { ext: partner_ext(&s.agent.pubkey(), 30), ..swap(0, 10, 5)? };
    assert_eq!(s.agent_creates(&wrong_key), Err(engine_error(EngineError::MandateMismatch)));
    let right = IntentSpec { ext: partner_ext(&partner, 30), ..swap(0, 10, 5)? };
    s.agent_creates(&right)?;
    let stored = s.env.intent(&s.owner(), agent_nonce(0))?;
    assert_eq!((stored.partner, stored.partner_bps), (partner, 30));
    Ok(())
}

#[test]
fn only_the_named_agent_for_the_named_owner_and_pair_can_redeem() -> TestResult {
    let mut s = setup()?;
    let spec = swap(0, 10, 5)?;
    let impostor = s.env.funded()?;
    let ix = s.env.agent_intent_ix(&impostor.pubkey(), s.mandate, &s.trader, &s.market, &spec);
    assert_eq!(s.env.send(&impostor, &[ix], &[]), Err(engine_error(EngineError::Unauthorized)));
    let other_owner = s.env.trader(&s.market, FUNDED)?;
    let ix = s.env.agent_intent_ix(&s.agent.pubkey(), s.mandate, &other_owner, &s.market, &spec);
    assert_eq!(s.agent_sends(&[ix]), Err(engine_error(EngineError::Unauthorized)));
    let other = s.env.market(PROGRAM, &[], PROGRAM, &[])?;
    let elsewhere = Trader {
        key: s.trader.key.insecure_clone(),
        input: s.env.create_ata(&s.owner(), &other.input_mint, other.input_program)?,
        receiver: s.trader.receiver,
        receiver_authority: s.trader.receiver_authority,
    };
    let mixed = Market {
        input_mint: other.input_mint,
        output_mint: s.market.output_mint,
        input_program: s.market.input_program,
        output_program: s.market.output_program,
    };
    let ix = s.env.agent_intent_ix(&s.agent.pubkey(), s.mandate, &elsewhere, &mixed, &spec);
    assert_eq!(s.agent_sends(&[ix]), Err(engine_error(EngineError::MandateMismatch)));
    let stranger = s.env.funded()?;
    let foreign = s.env.create_token_account(&s.market.output_mint, &stranger.pubkey(), PROGRAM)?;
    let redirected = Trader {
        key: s.trader.key.insecure_clone(),
        input: s.trader.input,
        receiver: foreign,
        receiver_authority: stranger.pubkey(),
    };
    let ix = s.env.agent_intent_ix(&s.agent.pubkey(), s.mandate, &redirected, &s.market, &spec);
    assert_eq!(s.agent_sends(&[ix]), Err(engine_error(EngineError::MandateMismatch)));
    s.agent_creates(&spec)?;
    Ok(())
}

#[test]
fn advancing_the_epoch_or_revoking_ends_the_mandate() -> TestResult {
    let mut s = setup()?;
    s.agent_creates(&swap(0, 10, 5)?)?;
    let owner = s.owner();
    let bump = s.env.advance_epoch_ix(&owner, 5);
    s.owner_sends(&[bump])?;
    assert_eq!(s.agent_creates(&swap(1, 10, 5)?), Err(engine_error(EngineError::MandateRevoked)));
    let mut r = setup()?;
    let stranger = r.env.funded()?;
    let ix = r.env.revoke_mandate_ix(&stranger.pubkey(), r.mandate);
    assert_eq!(r.env.send(&stranger, &[ix], &[]), Err(engine_error(EngineError::Unauthorized)));
    r.agent_creates(&swap(0, 10, 5)?)?;
    let rent = r.env.lamports(&r.mandate);
    let before = r.env.lamports(&r.owner());
    let ix = r.env.revoke_mandate_ix(&r.owner(), r.mandate);
    let meta = r.owner_sends(&[ix])?;
    assert!(!r.env.exists(&r.mandate));
    assert_eq!(r.env.lamports(&r.owner()), before.saturating_add(rent).saturating_sub(5_000));
    let closed = events::<MandateClosed>(&meta).pop().ok_or("missing")?;
    assert_eq!(
        (closed.mandate, closed.owner, closed.agent, closed.spent, closed.intents),
        (r.mandate, r.owner(), r.agent.pubkey(), 10, 1)
    );
    assert_eq!(
        r.agent_creates(&swap(1, 10, 5)?),
        Err(anchor_error(anchor_lang::error::ErrorCode::AccountOwnedByWrongProgram))
    );
    Ok(())
}

#[test]
fn a_revoke_refuses_an_owner_that_cannot_take_back_the_rent() -> TestResult {
    let mut s = setup()?;
    let payer = s.env.funded()?;
    let owner = s.trader.key.insecure_clone();
    let mut ix = s.env.revoke_mandate_ix(&owner.pubkey(), s.mandate);
    for meta in ix.accounts.iter_mut().filter(|m| m.pubkey == owner.pubkey()) {
        meta.is_writable = false;
    }
    assert_eq!(
        s.env.send(&payer, &[ix], &[&owner]),
        Err(anchor_error(anchor_lang::error::ErrorCode::ConstraintMut))
    );
    assert!(s.env.exists(&s.mandate));
    Ok(())
}

impl Setup {
    fn fill(&mut self, n: u64) -> Result<litesvm::types::TransactionMetadata, TransactionError> {
        let solver = self.env.solver(&self.market, 1_000).map_err(|_| TransactionError::AccountNotFound)?;
        let fee_to = self.env.fee_account(&self.market).ok();
        let owner = self.owner();
        let ix = self.env.fill_ix(&solver, &owner, &self.market, agent_nonce(n), &self.trader.receiver, fee_to.as_ref(), 1_000);
        self.env.send(&solver.key, &[ix], &[])
    }

    fn begin(&mut self, n: u64) -> Result<litesvm::types::TransactionMetadata, TransactionError> {
        let solver = self.env.solver(&self.market, 1_000).map_err(|_| TransactionError::AccountNotFound)?;
        let fee_to = self.env.fee_account(&self.market).ok();
        let owner = self.owner();
        let begin = self.env.begin_fill_ix(&solver.key.pubkey(), &owner, &self.market, agent_nonce(n), &solver.input, fee_to.as_ref(), 1);
        let end = self.env.end_fill_ix(&solver.key.pubkey(), &owner, &self.market, agent_nonce(n), &self.trader.receiver, &solver.output, 1_000);
        self.env.send(&solver.key, &[begin, end], &[])
    }

    fn regrant(&mut self) -> TestResult {
        let args = mandate_terms(self.agent.pubkey(), VALID_UNTIL);
        let ix = self.env.create_mandate_ix(&self.trader, &self.market, args);
        self.owner_sends(&[ix])?;
        Ok(())
    }

    fn revoke(&mut self) -> TestResult {
        let ix = self.env.revoke_mandate_ix(&self.owner(), self.mandate);
        self.owner_sends(&[ix])?;
        Ok(())
    }
}

#[test]
fn the_agent_is_paid_its_fee_only_when_the_intent_fills() -> TestResult {
    const FEE: u64 = 10;
    let mut s = with_terms(intent_engine::MandateArgs {
        agent_fee: FEE,
        ..mandate_terms(Pubkey::default(), VALID_UNTIL)
    })?;
    assert_eq!(s.env.mandate(&s.mandate)?.agent_fee, FEE);
    let agent = s.agent.pubkey();
    let owner = s.owner();
    assert_eq!(
        s.agent_creates(&swap(0, 391, 1_000)?),
        Err(engine_error(EngineError::MandateCap))
    );
    assert_eq!(
        s.agent_creates(&swap(0, 390, 199)?),
        Err(engine_error(EngineError::MandatePrice))
    );
    let meta = s.agent_creates(&swap(0, 390, 200)?)?;
    assert_eq!(s.env.balance(&s.trader.input)?, FUNDED - 400);
    let intent = intent_pda(&owner, agent_nonce(0));
    assert_eq!(s.env.balance(&vault_pda(&intent))?, 400);
    assert_eq!(s.env.intent(&owner, agent_nonce(0))?.agent_fee, FEE);
    let m = s.env.mandate(&s.mandate)?;
    assert_eq!((m.spent, m.intents), (400, 1));
    let used = events::<MandateUsed>(&meta).pop().ok_or("missing")?;
    assert_eq!((used.escrowed, used.agent_fee, used.spent), (390, FEE, 400));
    let canonical = anchor_spl::associated_token::get_associated_token_address_with_program_id(
        &agent,
        &s.market.input_mint,
        &s.market.input_program,
    );
    assert_eq!(s.fill(0), Err(anchor_error(anchor_lang::error::ErrorCode::AccountNotInitialized)));
    s.env.agent_to = Some(None);
    assert_eq!(s.fill(0), Err(engine_error(EngineError::FeeAccountMissing)));
    let foreign = s
        .env
        .create_token_account(&s.market.input_mint, &agent, s.market.input_program)?;
    s.env.agent_to = Some(Some(foreign));
    assert_eq!(s.fill(0), Err(engine_error(EngineError::FeeAccountNotCanonical)));
    s.env.agent_to = None;
    assert_eq!(s.env.create_ata(&agent, &s.market.input_mint, s.market.input_program)?, canonical);
    let meta = s.fill(0)?;
    assert_eq!(s.env.balance(&canonical)?, FEE);
    assert_eq!(s.env.balance(&vault_pda(&intent))?, 0);
    assert_eq!(s.env.intent(&owner, agent_nonce(0))?.agent_fee, 0);
    let paid = events::<AgentPaid>(&meta).pop().ok_or("missing")?;
    assert_eq!((paid.intent, paid.agent, paid.account, paid.fee), (intent, agent, canonical, FEE));

    s.agent_creates(&swap(1, 90, 50)?)?;
    let cancel = s.env.cancel_ix(&owner, &s.market, agent_nonce(1), &s.trader.input);
    s.owner_sends(&[cancel])?;
    assert_eq!(s.env.balance(&s.trader.input)?, FUNDED - 400);
    assert_eq!(s.env.balance(&canonical)?, FEE);
    assert_eq!(s.env.intent(&owner, agent_nonce(1))?.agent_fee, 0);

    s.agent_creates(&swap(2, 90, 50)?)?;
    s.begin(2)?;
    assert_eq!(s.env.balance(&canonical)?, 2 * FEE);
    assert_eq!(s.env.intent(&owner, agent_nonce(2))?.agent_fee, 0);

    s.agent_creates(&swap(3, 90, 50)?)?;
    s.env.set_now(START_TS + 3_600);
    let refund = svm_tests::canonical_refund(&owner, &s.market);
    let expire = s.env.expire_ix(&agent, &owner, &s.market, agent_nonce(3), &refund);
    s.agent_sends(&[expire])?;
    assert_eq!(s.env.balance(&s.trader.input)?, FUNDED - 500);
    assert_eq!(s.env.balance(&canonical)?, 2 * FEE);
    assert_eq!(s.env.intent(&owner, agent_nonce(3))?.agent_fee, 0);
    Ok(())
}

#[test]
fn a_fee_that_leaves_no_room_for_an_intent_is_refused() -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(PROGRAM, &[], PROGRAM, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let agent = env.funded()?;
    let owner = trader.key.insecure_clone();
    let terms = mandate_terms(agent.pubkey(), VALID_UNTIL);
    let ix = env.create_mandate_ix(&trader, &market, intent_engine::MandateArgs { agent_fee: terms.per_intent, ..terms });
    assert_eq!(env.send(&owner, &[ix], &[]), Err(engine_error(EngineError::MandateInvalid)));
    let ix = env.create_mandate_ix(&trader, &market, intent_engine::MandateArgs { agent_fee: terms.per_intent - 1, ..terms });
    let meta = env.send(&owner, &[ix], &[])?;
    let created = events::<MandateCreated>(&meta).pop().ok_or("missing")?;
    assert_eq!(created.agent_fee, terms.per_intent - 1);
    Ok(())
}

#[test]
fn an_intent_records_the_grant_it_was_made_under() -> TestResult {
    let mut s = setup()?;
    let owner = s.owner();
    assert_eq!((s.env.mandate(&s.mandate)?.serial, s.env.user(&owner)?.grants), (1, 1));
    s.agent_creates(&swap(0, 10, 5)?)?;
    let stored = s.env.intent(&owner, agent_nonce(0))?;
    assert_eq!((stored.mandate, stored.mandate_serial), (s.mandate, 1));
    s.revoke()?;
    s.regrant()?;
    assert_eq!((s.env.mandate(&s.mandate)?.serial, s.env.user(&owner)?.grants), (2, 2));
    assert_eq!(s.agent_creates(&swap(1, 10, 5)?), Err(engine_error(EngineError::MandateMismatch)));
    s.agent_creates(&swap(agent_lane(2, 1), 10, 5)?)?;
    assert_eq!(s.env.intent(&owner, agent_lane(2, 1))?.mandate_serial, 2);
    let ix = s.env.create_intent_ix(&s.trader, &s.market, &IntentSpec { nonce: 0, ..swap(0, 10, 5)? });
    s.owner_sends(&[ix])?;
    let own = s.env.intent(&owner, 0)?;
    assert_eq!((own.mandate, own.mandate_serial), (Pubkey::default(), 0));
    Ok(())
}

#[test]
fn an_agent_intent_stays_fillable_after_its_mandate_ends_until_it_expires() -> TestResult {
    let mut s = with_terms(mandate_terms(Pubkey::default(), START_TS + 600))?;
    s.agent_creates(&swap(0, 10, 5)?)?;
    s.env.set_now(START_TS + 601);
    assert_eq!(
        s.agent_creates(&swap(1, 10, 5)?),
        Err(engine_error(EngineError::MandateExpired))
    );
    s.fill(0)?;
    assert!(s.env.balance(&s.trader.receiver)? >= 5);
    Ok(())
}

#[test]
fn cancelling_an_agent_intent_does_not_return_its_share_of_the_mandate_budget() -> TestResult {
    let mut s = setup()?;
    s.agent_creates(&swap(0, 10, 5)?)?;
    let before = s.env.mandate(&s.mandate)?;
    let owner = s.owner();
    let cancel = s.env.cancel_ix(&owner, &s.market, agent_nonce(0), &s.trader.input);
    s.owner_sends(&[cancel])?;
    let after = s.env.mandate(&s.mandate)?;
    assert_eq!((after.spent, after.intents), (before.spent, before.intents));
    assert_eq!(s.env.balance(&s.trader.input)?, FUNDED);
    Ok(())
}

#[test]
fn a_mandate_account_the_program_does_not_own_revokes_its_intents() -> TestResult {
    let mut s = setup()?;
    s.agent_creates(&swap(0, 10, 5)?)?;
    let mut account = s.env.svm.get_account(&s.mandate).ok_or("mandate missing")?;
    account.owner = anchor_lang::system_program::ID;
    s.env.svm.set_account(s.mandate, account)?;
    assert_eq!(s.fill(0), Err(engine_error(EngineError::MandateRevoked)));
    assert_eq!(s.begin(0), Err(engine_error(EngineError::MandateRevoked)));
    Ok(())
}

#[test]
fn a_live_mandate_lets_its_intents_be_filled() -> TestResult {
    let mut s = setup()?;
    s.agent_creates(&swap(0, 10, 5)?)?;
    s.fill(0)?;
    assert!(s.env.balance(&s.trader.receiver)? >= 5);
    s.agent_creates(&swap(1, 10, 5)?)?;
    s.begin(1)?;
    assert_eq!(s.env.intent(&s.owner(), agent_nonce(1))?.filled, 10);
    Ok(())
}

#[test]
fn fills_refuse_intents_whose_mandate_was_revoked_or_its_epoch_advanced() -> TestResult {
    let revoked = |e: EngineError| Err(engine_error(e));
    let mut s = setup()?;
    s.agent_creates(&swap(0, 10, 5)?)?;
    s.revoke()?;
    assert_eq!(s.fill(0), revoked(EngineError::MandateRevoked));
    assert_eq!(s.begin(0), revoked(EngineError::MandateRevoked));
    s.regrant()?;
    assert_eq!(s.fill(0), revoked(EngineError::MandateRevoked));
    assert_eq!(s.begin(0), revoked(EngineError::MandateRevoked));
    let second = agent_lane(2, 1);
    s.agent_creates(&swap(second, 10, 5)?)?;
    let owner = s.owner();
    let ix = s.env.advance_epoch_ix(&owner, 9);
    s.owner_sends(&[ix])?;
    assert_eq!(s.fill(second), revoked(EngineError::MandateRevoked));
    assert_eq!(s.begin(second), revoked(EngineError::MandateRevoked));
    let refund = s.trader.input;
    let before = s.env.balance(&refund)?;
    let ix = s.env.cancel_ix(&owner, &s.market, second, &refund);
    s.owner_sends(&[ix])?;
    assert_eq!(s.env.balance(&refund)?, before + 10);
    Ok(())
}

#[test]
fn a_fill_must_name_the_intents_own_mandate_and_owner() -> TestResult {
    let mut s = setup()?;
    s.agent_creates(&swap(0, 10, 5)?)?;
    let owner = s.owner();
    let user = svm_tests::user_pda(&owner);
    s.env.mandate_accounts = Some((None, None));
    assert_eq!(s.fill(0), Err(engine_error(EngineError::MandateRevoked)));
    s.env.mandate_accounts = Some((Some(s.mandate), None));
    assert_eq!(s.fill(0), Err(engine_error(EngineError::MandateRevoked)));
    s.env.mandate_accounts = Some((None, Some(user)));
    assert_eq!(s.begin(0), Err(engine_error(EngineError::MandateRevoked)));
    let args = intent_engine::MandateArgs { id: 1, ..mandate_terms(s.agent.pubkey(), VALID_UNTIL) };
    let ix = s.env.create_mandate_ix(&s.trader, &s.market, args);
    s.owner_sends(&[ix])?;
    let other = mandate_pda(&owner, &s.agent.pubkey(), 1);
    s.env.mandate_accounts = Some((Some(other), Some(user)));
    assert_eq!(s.fill(0), Err(engine_error(EngineError::MandateMismatch)));
    let stranger = s.env.trader(&s.market, 1)?;
    s.env.mandate_accounts = Some((Some(s.mandate), Some(svm_tests::user_pda(&stranger.key.pubkey()))));
    assert_eq!(s.fill(0), Err(engine_error(EngineError::MandateMismatch)));
    s.env.mandate_accounts = None;
    s.fill(0)?;
    Ok(())
}

#[test]
fn the_engine_still_applies_its_own_rules_and_the_owners_allowance() -> TestResult {
    let mut s = setup()?;
    let owner = s.owner();
    let revoke = anchor_spl::token_2022::spl_token_2022::instruction::revoke(&PROGRAM, &s.trader.input, &owner, &[])?;
    s.owner_sends(&[revoke])?;
    assert_eq!(s.agent_creates(&swap(0, 10, 5)?), Err(solana_transaction_error::TransactionError::InstructionError(0, solana_instruction_error::InstructionError::Custom(anchor_spl::token_2022::spl_token_2022::error::TokenError::OwnerMismatch as u32))));
    assert_eq!(s.env.balance(&s.trader.input)?, FUNDED);
    s.env.approve_delegate(&s.trader, &s.market, 10)?;
    let guardian = s.env.guardian.insecure_clone();
    let pause = s.env.raise_pause_ix(&guardian.pubkey(), intent_engine::state::PAUSE_CREATE);
    s.env.send(&guardian, &[pause], &[])?;
    assert_eq!(s.agent_creates(&swap(0, 10, 5)?), Err(engine_error(EngineError::CreatePaused)));
    assert_eq!(s.env.mandate(&s.mandate)?.spent, 0);
    Ok(())
}

#[test]
fn granting_and_using_a_mandate_stay_within_the_compute_baseline() -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(PROGRAM, &[], PROGRAM, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    env.approve_delegate(&trader, &market, ALLOWANCE)?;
    let agent = env.funded()?;
    let owner = trader.key.insecure_clone();
    let ix = env.create_mandate_ix(&trader, &market, mandate_terms(agent.pubkey(), VALID_UNTIL));
    let mandate = mandate_pda(&owner.pubkey(), &agent.pubkey(), 0);
    let granted = env
        .send(&owner, &[ix], &[])?
        .compute_units_consumed
        .saturating_sub(bump_search_cost(env.mandate(&mandate)?.bump));
    let ix = env.agent_intent_ix(&agent.pubkey(), mandate, &trader, &market, &swap(0, 400, 200)?);
    let delegate_bump = Pubkey::find_program_address(
        &[intent_engine::state::DELEGATE_SEED, owner.pubkey().as_ref()],
        &intent_engine::ID,
    )
    .1;
    let spent = env.send(&agent, &[ix], &[])?.compute_units_consumed;
    let intent = env.intent(&owner.pubkey(), agent_nonce(0))?;
    let used = spent
        .saturating_sub(bump_search_cost(intent.bump))
        .saturating_sub(bump_search_cost(intent.vault_bump))
        .saturating_sub(bump_search_cost(delegate_bump));
    cu_gates(&[
        (format!("create_mandate{CU_SUFFIX}"), granted),
        (format!("create_intent_by_agent{CU_SUFFIX}"), used),
    ])
}

#[test]
fn a_fill_paying_every_payee_stays_within_the_compute_baseline() -> TestResult {
    let partner = Pubkey::new_unique();
    let mut s = with_terms(intent_engine::MandateArgs {
        partner,
        partner_bps: 30,
        agent_fee: 10,
        ..mandate_terms(Pubkey::default(), VALID_UNTIL)
    })?;
    let agent = s.agent.pubkey();
    let spec = IntentSpec { ext: partner_ext(&partner, 30), ..swap(0, 390, 200)? };
    s.agent_creates(&spec)?;
    let partner_to = s.env.create_ata(&partner, &s.market.input_mint, s.market.input_program)?;
    let agent_to = s.env.create_ata(&agent, &s.market.input_mint, s.market.input_program)?;
    let fee_to = s.env.fee_account(&s.market)?;
    s.env.partner_to = Some(partner_to);
    let meta = s.fill(0)?;
    assert_eq!(s.env.balance(&agent_to)?, 10);
    assert!(s.env.balance(&partner_to)? > 0);
    assert!(s.env.balance(&fee_to)? > 0);
    let bump_of = |owner: &Pubkey| {
        Pubkey::find_program_address(
            &[owner.as_ref(), s.market.input_program.as_ref(), s.market.input_mint.as_ref()],
            &anchor_spl::associated_token::ID,
        )
        .1
    };
    let fee_recipient = s.env.config()?.fee_recipient;
    let normalized = [fee_recipient, partner, agent]
        .iter()
        .fold(meta.compute_units_consumed, |cu, owner| cu.saturating_sub(bump_search_cost(bump_of(owner))));
    cu_gates(&[(format!("fill_every_payee{CU_SUFFIX}"), normalized)])
}

#[test]
fn a_payee_that_refuses_payment_cannot_block_the_fill_and_its_fee_returns_to_the_owner() -> TestResult {
    let partner = Keypair::new();
    let terms = intent_engine::MandateArgs {
        partner: partner.pubkey(),
        partner_bps: 30,
        agent_fee: 10,
        ..mandate_terms(Pubkey::default(), VALID_UNTIL)
    };
    let mut s = with_market(terms, &[svm_tests::MintExt::Freezable])?;
    let owner = s.owner();
    let agent = s.agent.insecure_clone();
    let spec = IntentSpec { ext: partner_ext(&partner.pubkey(), 30), ..swap(0, 390, 200)? };
    s.agent_creates(&spec)?;
    let partner_to = s.env.create_ata(&partner.pubkey(), &s.market.input_mint, s.market.input_program)?;
    let agent_to = s.env.create_ata(&agent.pubkey(), &s.market.input_mint, s.market.input_program)?;
    let fee_to = s.env.fee_account(&s.market)?;
    if PROGRAM == anchor_spl::token_2022::ID {
        s.env.add_account_ext(&agent, &agent_to, PROGRAM, svm_tests::AccountExt::MemoRequired)?;
    } else {
        s.env.set_frozen(&agent_to, &s.market.input_mint, PROGRAM, true)?;
    }
    s.env.set_frozen(&partner_to, &s.market.input_mint, PROGRAM, true)?;
    s.env.partner_to = Some(partner_to);
    let intent = intent_pda(&owner, agent_nonce(0));
    let before = s.env.balance(&s.trader.input)?;
    let meta = s.fill(0)?;
    assert_eq!((s.env.balance(&agent_to)?, s.env.balance(&partner_to)?), (0, 0));
    assert!(s.env.balance(&fee_to)? > 0);
    assert!(events::<AgentPaid>(&meta).is_empty());
    let filled = events::<IntentFilled>(&meta).pop().ok_or("missing")?;
    assert_eq!(filled.partner_fee, 0);
    let withheld: Vec<_> = events::<intent_engine::events::FeeWithheld>(&meta)
        .into_iter()
        .map(|e| (e.intent, e.payee, e.account, e.fee, e.role))
        .collect();
    let partner_share = withheld.first().map_or(0, |w| w.3);
    assert!(partner_share > 0);
    assert_eq!(
        withheld,
        [
            (intent, partner.pubkey(), partner_to, partner_share, intent_engine::events::WITHHELD_PARTNER),
            (intent, agent.pubkey(), agent_to, 10, intent_engine::events::WITHHELD_AGENT),
        ]
    );
    let held = s.env.balance(&vault_pda(&intent))?;
    assert_eq!(held, partner_share.saturating_add(10));
    assert_eq!(s.env.intent(&owner, agent_nonce(0))?.agent_fee, 0);
    let cranker = s.env.funded()?;
    let close = s.env.close_ix_with(&cranker.pubkey(), &owner, &agent.pubkey(), &s.market, agent_nonce(0), &s.trader.input);
    s.env.send(&cranker, &[close], &[])?;
    assert!(!s.env.exists(&intent));
    assert_eq!(s.env.balance(&s.trader.input)?, before + held);
    Ok(())
}

#[test]
fn an_agent_can_only_create_in_its_own_grants_nonce_lane() -> TestResult {
    let mut s = setup()?;
    let owner = s.owner();
    let rival = s.env.funded()?;
    let ix = s.env.create_mandate_ix(
        &s.trader,
        &s.market,
        intent_engine::MandateArgs {
            agent: rival.pubkey(),
            ..mandate_terms(rival.pubkey(), VALID_UNTIL)
        },
    );
    s.owner_sends(&[ix])?;
    let rival_mandate = mandate_pda(&owner, &rival.pubkey(), 0);
    assert_eq!(s.env.mandate(&rival_mandate)?.serial, 2);
    let by_rival = |s: &mut Setup, nonce: u64| -> Result<litesvm::types::TransactionMetadata, TransactionError> {
        let spec = IntentSpec { nonce, ..swap(0, 10, 5).map_err(|_| TransactionError::AccountNotFound)? };
        let ix = s.env.agent_intent_ix(&rival.pubkey(), rival_mandate, &s.trader, &s.market, &spec);
        s.env.send(&rival, &[ix], &[])
    };
    for stolen in [agent_lane(1, 0), agent_lane(1, 7), MANDATE_NONCE_BIT, MANDATE_NONCE_BIT | 3, agent_lane(3, 0)] {
        assert_eq!(by_rival(&mut s, stolen), Err(engine_error(EngineError::MandateMismatch)), "{stolen:#x}");
    }
    by_rival(&mut s, agent_lane(2, 0))?;
    s.agent_creates(&swap(0, 10, 5)?)?;
    assert_eq!(s.agent_creates(&swap(agent_lane(2, 1), 10, 5)?), Err(engine_error(EngineError::MandateMismatch)));
    assert_eq!(s.env.intent(&owner, agent_lane(1, 0))?.mandate, s.mandate);
    assert_eq!(s.env.intent(&owner, agent_lane(2, 0))?.mandate, rival_mandate);
    Ok(())
}

#[test]
fn an_agent_cannot_draw_from_the_named_account_once_the_owner_hands_it_to_someone_else() -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(PROGRAM, &[], PROGRAM, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let owner = trader.key.insecure_clone();
    let held = env.create_token_account(&market.input_mint, &owner.pubkey(), PROGRAM)?;
    env.mint_to(&market.input_mint, &held, PROGRAM, FUNDED)?;
    let named = Trader {
        key: owner.insecure_clone(),
        input: held,
        receiver: trader.receiver,
        receiver_authority: trader.receiver_authority,
    };
    env.approve_delegate(&named, &market, ALLOWANCE)?;
    let agent = env.funded()?;
    let grant = env.create_mandate_ix(&named, &market, mandate_terms(agent.pubkey(), VALID_UNTIL));
    env.send(&owner, &[grant], &[])?;
    let mandate = mandate_pda(&owner.pubkey(), &agent.pubkey(), 0);
    let buyer = env.funded()?;
    env.reassign_owner(&owner, &held, &buyer.pubkey(), PROGRAM)?;
    let ix = env.agent_intent_ix(&agent.pubkey(), mandate, &named, &market, &swap(0, 10, 5)?);
    assert_eq!(
        env.send(&agent, &[ix], &[]),
        Err(anchor_error(anchor_lang::error::ErrorCode::ConstraintTokenOwner))
    );
    assert_eq!(env.balance(&held)?, FUNDED);
    Ok(())
}

#[test]
fn an_agent_cannot_bring_its_own_config_to_create_while_creation_is_paused() -> TestResult {
    let mut s = setup()?;
    let real = svm_tests::config_pda();
    let copy = s.env.svm.get_account(&real).ok_or("config missing")?;
    let forged = Pubkey::new_unique();
    s.env.svm.set_account(forged, copy)?;
    let guardian = s.env.guardian.insecure_clone();
    let pause = s.env.raise_pause_ix(&guardian.pubkey(), intent_engine::state::PAUSE_CREATE);
    s.env.send(&guardian, &[pause], &[])?;
    let spec = swap(0, 10, 5)?;
    assert_eq!(s.agent_creates(&spec), Err(engine_error(EngineError::CreatePaused)));
    let mut ix = s.by_agent(&spec);
    ix.accounts.iter_mut().find(|m| m.pubkey == real).ok_or("config not in instruction")?.pubkey = forged;
    assert_eq!(
        s.agent_sends(&[ix]),
        Err(anchor_error(anchor_lang::error::ErrorCode::ConstraintAddress))
    );
    assert_eq!(s.env.balance(&s.trader.input)?, FUNDED);
    Ok(())
}
