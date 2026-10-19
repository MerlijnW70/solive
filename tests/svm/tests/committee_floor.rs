use anchor_lang::prelude::Pubkey;
use intent_core::kinds::{attested_result, Kind};
use intent_engine::errors::EngineError;
use intent_engine::events::CommitteeFloorSet;
use intent_engine::floors::committee_floor;
use intent_engine::state::MAX_COMMITTEE_FLOORS;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    agent_lane, config_pda, create_committee_ix, ed25519_ix, engine_error, engine_error_at,
    engine_ix, event_authority, events, intent_pda, mandate_pda, mandate_terms, sorted_members,
    swap_spec, vault_pda, Env, IntentSpec, Market, TestResult, Trader, DOMAIN, START_TS,
};

const PROGRAM: Pubkey = anchor_spl::token::ID;
const FUNDED: u64 = 1_000_000;
const FLOOR: u64 = 500;
const LATER: i64 = START_TS + 86_400;
const SPEC: [u8; 32] = [0x5a; 32];

type Sent = Result<litesvm::types::TransactionMetadata, TransactionError>;

struct World {
    env: Env,
    market: Market,
    trader: Trader,
    judge: Pubkey,
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
        judge: Pubkey::new_unique(),
    })
}

fn set_floor_ix(admin: &Pubkey, mint: &Pubkey, floor: u64) -> Instruction {
    engine_ix(
        intent_engine::accounts::SetCommitteeFloor {
            admin: *admin,
            config: config_pda(),
            mint: *mint,
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::SetCommitteeFloor { floor },
    )
}

fn proof_spec(nonce: u64, amount: u64, attestor: &Pubkey) -> TestResult<IntentSpec> {
    Ok(IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: amount,
            min_result: 1,
            max_result: 1,
            attestor: attestor.to_bytes(),
            spec_hash: SPEC,
            judge_fee: 0,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        expires_at: LATER,
        ..swap_spec(nonce, amount)?
    })
}

impl World {
    fn admin(&self) -> Keypair {
        self.env.authority.insecure_clone()
    }

    fn set_floor(&mut self, mint: Pubkey, floor: u64) -> Sent {
        let admin = self.admin();
        let ix = set_floor_ix(&admin.pubkey(), &mint, floor);
        self.env.send(&admin, &[ix], &[])
    }

    fn floor(&mut self, floor: u64) -> Sent {
        let mint = self.market.input_mint;
        self.set_floor(mint, floor)
    }

    fn convene(&mut self, size: usize, threshold: u8) -> TestResult<Pubkey> {
        let keys: Vec<Pubkey> = sorted_members(size).iter().map(Signer::pubkey).collect();
        let payer = self.env.funded()?;
        let (ix, address) =
            create_committee_ix(&payer.pubkey(), &keys, threshold, &Pubkey::new_unique())?;
        self.env.send(&payer, &[ix], &[])?;
        Ok(address)
    }

    fn create(
        &mut self,
        nonce: u64,
        amount: u64,
        attestor: &Pubkey,
        committee: Option<Pubkey>,
    ) -> TestResult<Sent> {
        self.env.committee = committee;
        let ix = self.env.create_intent_ix(
            &self.trader,
            &self.market,
            &proof_spec(nonce, amount, attestor)?,
        );
        let key = self.trader.key.insecure_clone();
        Ok(self.env.send(&key, &[ix], &[]))
    }

    fn created(&self, nonce: u64) -> bool {
        self.env
            .exists(&intent_pda(&self.trader.key.pubkey(), nonce))
    }
}

fn required() -> Option<TransactionError> {
    Some(engine_error(EngineError::CommitteeRequired))
}

#[test]
fn a_single_judge_is_refused_at_the_floor_and_accepted_just_below() -> TestResult {
    let mut w = world()?;
    w.floor(FLOOR)?;
    let judge = w.judge;
    w.create(0, FLOOR - 1, &judge, None)??;
    assert!(w.created(0));
    let vault = vault_pda(&intent_pda(&w.trader.key.pubkey(), 0));
    assert_eq!(w.env.balance(&vault)?, FLOOR - 1);
    assert_eq!(w.create(1, FLOOR, &judge, None)?.err(), required());
    assert_eq!(w.create(1, FLOOR + 1, &judge, None)?.err(), required());
    assert!(!w.created(1));
    assert_eq!(w.env.balance(&w.trader.input)?, FUNDED - (FLOOR - 1));
    Ok(())
}

#[test]
fn a_two_of_n_committee_is_accepted_at_the_floor() -> TestResult {
    let mut w = world()?;
    w.floor(FLOOR)?;
    let two_of_three = w.convene(3, 2)?;
    w.create(0, FLOOR, &two_of_three, Some(two_of_three))??;
    let two_of_two = w.convene(2, 2)?;
    w.create(1, 10 * FLOOR, &two_of_two, Some(two_of_two))??;
    assert!(w.created(0) && w.created(1));
    assert_eq!(w.env.balance(&w.trader.input)?, FUNDED - 11 * FLOOR);
    Ok(())
}

#[test]
fn a_one_of_n_committee_does_not_count() -> TestResult {
    let mut w = world()?;
    w.floor(FLOOR)?;
    let one_of_three = w.convene(3, 1)?;
    assert_eq!(
        w.create(0, FLOOR, &one_of_three, Some(one_of_three))?.err(),
        required()
    );
    let one_of_one = w.convene(1, 1)?;
    assert_eq!(
        w.create(0, FLOOR, &one_of_one, Some(one_of_one))?.err(),
        required()
    );
    assert!(!w.created(0));
    w.create(0, FLOOR - 1, &one_of_three, Some(one_of_three))??;
    Ok(())
}

#[test]
fn a_committee_counts_only_as_the_named_attestor() -> TestResult {
    let mut w = world()?;
    w.floor(FLOOR)?;
    let committee = w.convene(3, 2)?;
    let judge = w.judge;
    assert_eq!(
        w.create(0, FLOOR, &judge, Some(committee))?.err(),
        required()
    );
    assert_eq!(w.create(0, FLOOR, &committee, None)?.err(), required());
    assert!(!w.created(0));
    w.create(0, FLOOR, &committee, Some(committee))??;
    Ok(())
}

#[test]
fn a_floor_of_zero_imposes_none() -> TestResult {
    let mut w = world()?;
    let judge = w.judge;
    let mint = w.market.input_mint;
    assert_eq!(committee_floor(&w.env.config()?, &mint), 0);
    w.create(0, 10 * FLOOR, &judge, None)??;
    w.floor(FLOOR)?;
    assert_eq!(w.create(1, FLOOR, &judge, None)?.err(), required());
    w.floor(0)?;
    assert_eq!(committee_floor(&w.env.config()?, &mint), 0);
    w.create(1, 10 * FLOOR, &judge, None)??;
    assert_eq!(w.env.balance(&w.trader.input)?, FUNDED - 20 * FLOOR);
    Ok(())
}

#[test]
fn a_floor_binds_only_its_own_mint_and_only_proof_escrows() -> TestResult {
    let mut w = world()?;
    let other = w.env.market(PROGRAM, &[], PROGRAM, &[])?;
    w.set_floor(other.input_mint, 1)?;
    let judge = w.judge;
    w.create(0, 10 * FLOOR, &judge, None)??;
    w.floor(FLOOR)?;
    let ix = w
        .env
        .create_intent_ix(&w.trader, &w.market, &swap_spec(1, 10 * FLOOR)?);
    let key = w.trader.key.insecure_clone();
    w.env.send(&key, &[ix], &[])?;
    let config = w.env.config()?;
    assert_eq!(committee_floor(&config, &w.market.input_mint), FLOOR);
    assert_eq!(committee_floor(&config, &other.input_mint), 1);
    Ok(())
}

#[test]
fn each_creation_path_enforces_the_floor() -> TestResult {
    let mut w = world()?;
    w.floor(FLOOR)?;
    let judge = w.judge;
    let committee = w.convene(3, 2)?;
    let owner = w.trader.key.pubkey();
    let key = w.trader.key.insecure_clone();
    let relayer = w.env.funded()?;
    w.env.approve_delegate(&w.trader, &w.market, FUNDED)?;

    for (n, (attestor, attach, want)) in (0u64..).zip([
        (judge, None, Some(EngineError::CommitteeRequired)),
        (committee, None, Some(EngineError::CommitteeRequired)),
        (committee, Some(committee), None),
    ]) {
        w.env.committee = attach;
        let ix = w
            .env
            .create_intent_ix(&w.trader, &w.market, &proof_spec(n, FLOOR, &attestor)?);
        let got = w.env.send(&key, &[ix], &[]);
        let signed = proof_spec(10 + n, FLOOR, &attestor)?;
        let message = w
            .env
            .signed_message(&w.trader, &w.market, &signed, DOMAIN, LATER);
        let ixs = [
            ed25519_ix(&key, &message),
            w.env
                .create_signed_ix(&relayer.pubkey(), &w.trader, &w.market, &signed, LATER),
        ];
        let got_signed = w.env.send(&relayer, &ixs, &[]);
        match want {
            Some(e) => {
                assert_eq!(got.err(), Some(engine_error_at(0, e)));
                assert_eq!(got_signed.err(), Some(engine_error_at(1, e)));
            }
            None => {
                assert!(got.is_ok(), "{got:?}");
                assert!(got_signed.is_ok(), "{got_signed:?}");
            }
        }
        assert_eq!(w.created(n), want.is_none());
        assert_eq!(w.created(10 + n), want.is_none());
    }

    let agent = w.env.funded()?;
    let args = mandate_terms(agent.pubkey(), LATER);
    let ix = w.env.create_mandate_ix(&w.trader, &w.market, args);
    w.env.send(&key, &[ix], &[])?;
    let mandate = mandate_pda(&owner, &agent.pubkey(), args.id);
    let agent_spec = IntentSpec {
        nonce: agent_lane(1, 0),
        expires_at: START_TS + 3_600,
        ..proof_spec(0, FLOOR, &judge)?
    };
    let ix = w
        .env
        .agent_intent_ix(&agent.pubkey(), mandate, &w.trader, &w.market, &agent_spec);
    assert_eq!(
        w.env.send(&agent, &[ix], &[]).err(),
        Some(engine_error(EngineError::MandateKind))
    );
    assert!(!w.env.exists(&intent_pda(&owner, agent_lane(1, 0))));
    assert_eq!(w.env.balance(&w.trader.input)?, FUNDED - 2 * FLOOR);
    Ok(())
}

#[test]
fn only_the_admin_sets_a_floor_and_the_table_holds_a_bounded_number_of_mints() -> TestResult {
    let mut w = world()?;
    let mint = w.market.input_mint;
    let stranger = w.env.funded()?;
    let ix = set_floor_ix(&stranger.pubkey(), &mint, FLOOR);
    assert_eq!(
        w.env.send(&stranger, &[ix], &[]).err(),
        Some(engine_error(EngineError::Unauthorized))
    );
    assert_eq!(committee_floor(&w.env.config()?, &mint), 0);

    let meta = w.floor(FLOOR)?;
    let set = events::<CommitteeFloorSet>(&meta);
    assert_eq!(set.len(), 1);
    let event = set.first().ok_or("no event")?;
    assert_eq!((event.mint, event.floor), (mint, FLOOR));
    w.floor(2 * FLOOR)?;
    assert_eq!(committee_floor(&w.env.config()?, &mint), 2 * FLOOR);

    let mut others = Vec::new();
    for _ in 1..MAX_COMMITTEE_FLOORS {
        let market = w.env.market(PROGRAM, &[], PROGRAM, &[])?;
        w.set_floor(market.input_mint, FLOOR)?;
        others.push(market.input_mint);
    }
    let extra = w.env.market(PROGRAM, &[], PROGRAM, &[])?;
    assert_eq!(
        w.set_floor(extra.input_mint, FLOOR).err(),
        Some(engine_error(EngineError::CommitteeFloorsFull))
    );
    w.set_floor(extra.input_mint, 0)?;
    let freed = others.first().copied().ok_or("no mint")?;
    w.set_floor(freed, 0)?;
    w.set_floor(extra.input_mint, 3 * FLOOR)?;
    let config = w.env.config()?;
    assert_eq!(committee_floor(&config, &freed), 0);
    assert_eq!(committee_floor(&config, &extra.input_mint), 3 * FLOOR);
    assert_eq!(committee_floor(&config, &mint), 2 * FLOOR);
    Ok(())
}
