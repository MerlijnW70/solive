use anchor_lang::prelude::Pubkey;
use intent_core::fee::split_fee;
use intent_core::kinds::ALL_KINDS_MASK;
use intent_core::kinds::{swap_exact_in, Kind};
use intent_core::lifecycle::Status;
use intent_engine::errors::EngineError;
use intent_engine::state::{
    MintCap, BPS, MAX_CRANK_BOUNTY, MAX_CREATE_FEE, MAX_FEE_BPS, MINT_CAP_SEED, PAUSE_ALL,
};
use intent_engine::{ConfigUpdate, Economics};
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    agent_lane, canonical_refund, config_pda, ed25519_ix, engine_error, engine_error_at, engine_ix,
    event_authority, intent_pda, load, mandate_pda, mandate_terms, pda, swap_spec, vault_pda, Env,
    IntentSpec, Market, Solver, TestResult, Trader, DOMAIN, START_TS,
};

const PROGRAM: Pubkey = anchor_spl::token::ID;
const FUNDED: u64 = 1_000_000;
const ESCROW: u64 = 300_000;
const MIN_OUT: u64 = 1;

struct World {
    env: Env,
    market: Market,
    trader: Trader,
    solver: Solver,
    fee_to: Pubkey,
}

fn world() -> TestResult<World> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(PROGRAM, &[], PROGRAM, &[])?;
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

    fn admin_sends(&mut self, ix: solana_instruction::Instruction) -> TestResult {
        let admin = self.env.authority.insecure_clone();
        self.env.send(&admin, &[ix], &[])?;
        Ok(())
    }

    fn fill(&mut self, nonce: u64, max_fee_bps: u16) -> Result<(), TransactionError> {
        let owner = self.owner();
        self.env.max_fee_bps = max_fee_bps;
        let ix = self.env.fill_ix(
            &self.solver,
            &owner,
            &self.market,
            nonce,
            &self.trader.receiver,
            Some(&self.fee_to),
            MIN_OUT,
        );
        let solver = self.solver.key.insecure_clone();
        self.env.send(&solver, &[ix], &[]).map(|_| ())
    }

    fn mint_cap(&self) -> Pubkey {
        pda(&[MINT_CAP_SEED, self.market.input_mint.as_ref()])
    }

    fn outstanding(&self) -> TestResult<u64> {
        Ok(load::<MintCap>(&self.env.svm, &self.mint_cap())?.outstanding)
    }

    fn set_caps(&mut self, total_limit: u64, required: bool) -> TestResult {
        let admin = self.env.authority.pubkey();
        let set = engine_ix(
            intent_engine::accounts::SetMintCap {
                admin,
                payer: admin,
                config: config_pda(),
                mint: self.market.input_mint,
                mint_cap: self.mint_cap(),
                system_program: anchor_lang::system_program::ID,
                event_authority: event_authority(),
                program: intent_engine::ID,
            },
            intent_engine::instruction::SetMintCap {
                max_per_order: ESCROW,
                window_cap: FUNDED,
                window_secs: 3_600,
                total_limit,
            },
        );
        self.admin_sends(set)?;
        let require = engine_ix(
            intent_engine::accounts::SetCapsRequired {
                admin,
                config: config_pda(),
                event_authority: event_authority(),
                program: intent_engine::ID,
            },
            intent_engine::instruction::SetCapsRequired { required },
        );
        self.admin_sends(require)
    }

    fn worst_admin(&mut self) -> TestResult<Pubkey> {
        let admin = self.env.authority.pubkey();
        let recipient = Pubkey::new_unique();
        let ix = self.env.raise_pause_ix(&admin, PAUSE_ALL);
        self.admin_sends(ix)?;
        let ix = self.env.update_ix(
            &admin,
            ConfigUpdate {
                guardian: Pubkey::new_unique(),
                fee_recipient: recipient,
                enabled_kinds: 0,
                fee_bps: MAX_FEE_BPS,
                fill_disabled_kinds: ALL_KINDS_MASK,
            },
        );
        self.admin_sends(ix)?;
        let ix = self.env.economics_ix(
            &admin,
            Economics {
                kind_fee_mask: 0b1_1110,
                kind_fee_bps: [MAX_FEE_BPS; 4],
                partner_cut_bps: BPS,
                crank_bounty: MAX_CRANK_BOUNTY,
                create_fee: MAX_CREATE_FEE,
            },
        );
        self.admin_sends(ix)?;
        Ok(recipient)
    }
}

#[test]
fn no_admin_setting_can_stop_an_owner_from_getting_their_escrow_back() -> TestResult {
    let mut w = world()?;
    let owner = w.owner();
    let input = w.trader.input;
    w.set_caps(0, true)?;
    w.env.mint_cap = Some(w.mint_cap());
    for nonce in 0..3 {
        w.env
            .create_intent(&w.trader, &w.market, &swap_spec(nonce, ESCROW)?)?;
    }
    assert_eq!(w.outstanding()?, 3 * ESCROW);
    w.fill(2, w.env.settings().fee_bps)?;
    assert_eq!(w.outstanding()?, 2 * ESCROW);
    let stale = w.fee_to;
    let recipient = w.worst_admin()?;
    w.set_caps(1, false)?;
    assert_eq!(w.env.config()?.caps_required, 0);
    assert_eq!(
        w.fill(0, MAX_FEE_BPS),
        Err(engine_error(EngineError::FeeAccountNotCanonical))
    );
    w.fee_to = w
        .env
        .create_ata(&recipient, &w.market.input_mint, PROGRAM)?;
    assert_ne!(w.fee_to, stale);
    assert_eq!(
        w.fill(0, MAX_FEE_BPS),
        Err(engine_error(EngineError::FillPaused))
    );

    let key = w.trader.key.insecure_clone();
    let ix = w.env.cancel_ix(&owner, &w.market, 0, &input);
    w.env.send(&key, &[ix], &[])?;
    w.env.set_now(START_TS + 3_600);
    let cranker = w.env.funded()?;
    let refund = canonical_refund(&owner, &w.market);
    let ix = w
        .env
        .expire_ix(&cranker.pubkey(), &owner, &w.market, 1, &refund);
    w.env.send(&cranker, &[ix], &[])?;
    for nonce in 0..3 {
        let ix = w
            .env
            .close_ix_by(&cranker.pubkey(), &owner, &w.market, nonce, &refund);
        w.env.send(&cranker, &[ix], &[])?;
        assert!(!w.env.exists(&intent_pda(&owner, nonce)));
        assert!(!w.env.exists(&vault_pda(&intent_pda(&owner, nonce))));
    }
    assert_eq!(w.outstanding()?, 0);
    assert_eq!(w.env.balance(&input)?, FUNDED - ESCROW);
    assert_eq!(w.env.balance(&w.trader.receiver)?, MIN_OUT);
    Ok(())
}

#[test]
fn raising_fees_after_create_changes_nothing_an_open_intent_pays() -> TestResult {
    let mut w = world()?;
    let owner = w.owner();
    let input = w.trader.input;
    let before = w.env.settings().fee_bps;
    w.env
        .create_intent(&w.trader, &w.market, &swap_spec(0, ESCROW)?)?;
    let admin = w.env.authority.pubkey();
    let settings = w.env.settings();
    let ix = w.env.update_ix(
        &admin,
        ConfigUpdate {
            guardian: settings.guardian,
            fee_recipient: settings.fee_recipient,
            enabled_kinds: settings.enabled_kinds,
            fee_bps: MAX_FEE_BPS,
            fill_disabled_kinds: 0,
        },
    );
    w.admin_sends(ix)?;
    assert!(before < MAX_FEE_BPS);
    assert_eq!(w.env.intent(&owner, 0)?.fee_bps, before);
    assert_eq!(
        w.fill(0, before - 1),
        Err(engine_error(EngineError::FeeAboveBound))
    );
    assert_eq!(w.env.intent(&owner, 0)?.status, Status::Open as u8);
    w.fill(0, before)?;
    let split = split_fee(ESCROW, before).map_err(|e| format!("{e:?}"))?;
    assert_eq!(w.env.balance(&w.trader.receiver)?, MIN_OUT);
    assert_eq!(w.env.balance(&input)?, FUNDED - ESCROW);
    assert_eq!(w.env.balance(&w.solver.input)?, split.net);
    assert_eq!(w.env.balance(&w.fee_to)?, split.fee);
    Ok(())
}

#[test]
fn every_create_path_refuses_a_create_fee_or_bounty_above_its_ceiling() -> TestResult {
    const FEE: u32 = 30_000;
    const BOUNTY: u32 = 70_000;
    let mut w = world()?;
    let admin = w.env.authority.pubkey();
    let ix = w.env.economics_ix(
        &admin,
        Economics {
            kind_fee_mask: 0,
            kind_fee_bps: [0; 4],
            partner_cut_bps: 0,
            crank_bounty: BOUNTY,
            create_fee: FEE,
        },
    );
    w.admin_sends(ix)?;
    let ceilings = [
        (FEE - 1, BOUNTY, false),
        (FEE, BOUNTY - 1, false),
        (FEE, BOUNTY, true),
    ];
    let owner = w.owner();
    let key = w.trader.key.insecure_clone();
    let relayer = w.env.funded()?;
    let agent = w.env.funded()?;
    w.env.approve_delegate(&w.trader, &w.market, 10 * ESCROW)?;
    let args = intent_engine::MandateArgs {
        agent: agent.pubkey(),
        ..mandate_terms(agent.pubkey(), START_TS + 86_400)
    };
    let ix = w.env.create_mandate_ix(&w.trader, &w.market, args);
    w.env.send(&key, &[ix], &[])?;
    let mandate = mandate_pda(&owner, &agent.pubkey(), args.id);
    let expires_at = START_TS + 3_600;
    for (n, (max_create_fee, max_bounty, allowed)) in (0u64..).zip(ceilings) {
        w.env.max_create_fee = max_create_fee;
        w.env.max_bounty = max_bounty;
        let want = |got: Result<litesvm::types::TransactionMetadata, TransactionError>, at: u8| {
            if allowed {
                assert!(got.is_ok(), "{max_create_fee} {max_bounty}: {got:?}");
            } else {
                assert_eq!(
                    got.err(),
                    Some(engine_error_at(at, EngineError::CreateCostAboveCeiling))
                );
            }
        };
        want(
            w.env
                .create_intent(&w.trader, &w.market, &swap_spec(n, ESCROW)?),
            0,
        );

        let spec = swap_spec(10 + n, 1_000)?;
        let message = w
            .env
            .signed_message(&w.trader, &w.market, &spec, DOMAIN, expires_at);
        let ixs = [
            ed25519_ix(&key, &message),
            w.env
                .create_signed_ix(&relayer.pubkey(), &w.trader, &w.market, &spec, expires_at),
        ];
        want(w.env.send(&relayer, &ixs, &[]), 1);

        let agent_spec = IntentSpec {
            nonce: agent_lane(1, n),
            kind: Kind::SwapExactIn as u8,
            params: swap_exact_in::Params {
                amount_in: 10,
                min_out: 5,
            }
            .encode()
            .map_err(|e| format!("{e:?}"))?,
            expires_at,
            flags: 0,
            ext: Vec::new(),
        };
        let ix = w
            .env
            .agent_intent_ix(&agent.pubkey(), mandate, &w.trader, &w.market, &agent_spec);
        want(w.env.send(&agent, &[ix], &[]), 0);
    }
    Ok(())
}
