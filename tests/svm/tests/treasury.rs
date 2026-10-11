use anchor_lang::prelude::Pubkey;
use intent_core::kinds::{swap_exact_in, Kind};
use intent_engine::events::{FeeWithheld, IntentCreated, WITHHELD_TREASURY};
use intent_engine::Economics;
use litesvm::types::TransactionMetadata;
use solana_signer::Signer;
use svm_tests::{
    agent_lane, ed25519_ix, events, mandate_pda, mandate_terms, relay_program_path, swap_spec, Env,
    IntentSpec, Market, TestResult, Trader, DOMAIN, START_TS,
};

const PROGRAM: Pubkey = anchor_spl::token::ID;
const FUNDED: u64 = 10_000;
const ESCROW: u64 = 40;
const CREATE_FEE: u32 = 5_000;
const SUBMIT_BY: i64 = START_TS + 600;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Treasury {
    Healthy,
    Empty,
    Program,
}

#[derive(Clone, Copy, Debug)]
enum Path {
    Plain,
    Signed,
    Agent,
}

struct World {
    env: Env,
    market: Market,
    trader: Trader,
}

fn economics(create_fee: u32) -> Economics {
    Economics {
        kind_fee_mask: 0,
        kind_fee_bps: [0; 4],
        partner_cut_bps: 0,
        crank_bounty: 0,
        create_fee,
    }
}

fn world(create_fee: u32, treasury: Treasury) -> TestResult<World> {
    let mut env = Env::new()?;
    env.init_config()?;
    let admin = env.authority.insecure_clone();
    let ix = env.economics_ix(&admin.pubkey(), economics(create_fee));
    env.send(&admin, &[ix], &[])?;
    let key = env.fee_recipient;
    match treasury {
        Treasury::Healthy => {}
        Treasury::Empty => env.svm.set_account(key, Default::default())?,
        Treasury::Program => env.svm.add_program_from_file(key, relay_program_path())?,
    }
    let market = env.market(PROGRAM, &[], PROGRAM, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    env.approve_delegate(&trader, &market, ESCROW)?;
    Ok(World {
        env,
        market,
        trader,
    })
}

fn agent_spec() -> TestResult<IntentSpec> {
    Ok(IntentSpec {
        nonce: agent_lane(1, 0),
        kind: Kind::SwapExactIn as u8,
        params: swap_exact_in::Params {
            amount_in: ESCROW,
            min_out: ESCROW,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        expires_at: START_TS + 3_600,
        flags: 0,
        ext: Vec::new(),
    })
}

fn create(w: &mut World, path: Path) -> TestResult<TransactionMetadata> {
    let owner = w.trader.key.insecure_clone();
    Ok(match path {
        Path::Plain => w
            .env
            .create_intent(&w.trader, &w.market, &swap_spec(0, ESCROW)?)?,
        Path::Signed => {
            let relayer = w.env.funded()?;
            let spec = swap_spec(0, ESCROW)?;
            let message = w
                .env
                .signed_message(&w.trader, &w.market, &spec, DOMAIN, SUBMIT_BY);
            let ix =
                w.env
                    .create_signed_ix(&relayer.pubkey(), &w.trader, &w.market, &spec, SUBMIT_BY);
            w.env
                .send(&relayer, &[ed25519_ix(&owner, &message), ix], &[])?
        }
        Path::Agent => {
            let agent = w.env.funded()?;
            let terms = intent_engine::MandateArgs {
                agent: agent.pubkey(),
                ..mandate_terms(agent.pubkey(), START_TS + 3_600)
            };
            let ix = w.env.create_mandate_ix(&w.trader, &w.market, terms);
            w.env.send(&owner, &[ix], &[])?;
            let mandate = mandate_pda(&owner.pubkey(), &agent.pubkey(), terms.id);
            let ix = w.env.agent_intent_ix(
                &agent.pubkey(),
                mandate,
                &w.trader,
                &w.market,
                &agent_spec()?,
            );
            w.env.send(&agent, &[ix], &[])?
        }
    })
}

fn charged(create_fee: u32, treasury: Treasury, path: Path) -> TestResult<u32> {
    let mut w = world(create_fee, treasury)?;
    let key = w.env.fee_recipient;
    let before = w.env.lamports(&key);
    let meta = create(&mut w, path)?;
    let created = events::<IntentCreated>(&meta)
        .pop()
        .ok_or("missing IntentCreated")?;
    let gained = w
        .env
        .lamports(&key)
        .checked_sub(before)
        .ok_or("treasury lost lamports")?;
    assert_eq!(
        gained,
        u64::from(created.create_fee),
        "{treasury:?} {path:?}"
    );
    let withheld = events::<FeeWithheld>(&meta);
    if created.create_fee == create_fee {
        assert!(withheld.is_empty(), "{treasury:?} {path:?}");
    } else {
        assert_eq!(created.create_fee, 0, "{treasury:?} {path:?}");
        let [e] = withheld.as_slice() else {
            return Err(format!("{treasury:?} {path:?}: expected one FeeWithheld").into());
        };
        assert_eq!(
            (e.intent, e.payee, e.account, e.fee, e.role),
            (
                created.intent,
                key,
                key,
                u64::from(create_fee),
                WITHHELD_TREASURY
            )
        );
    }
    Ok(created.create_fee)
}

#[test]
fn creates_go_through_whatever_state_the_treasury_is_in() -> TestResult {
    for path in [Path::Plain, Path::Signed, Path::Agent] {
        assert_eq!(charged(CREATE_FEE, Treasury::Healthy, path)?, CREATE_FEE);
        assert_eq!(charged(CREATE_FEE, Treasury::Empty, path)?, 0);
        assert_eq!(charged(CREATE_FEE, Treasury::Program, path)?, 0);
    }
    Ok(())
}

#[test]
fn an_empty_treasury_takes_a_fee_exactly_when_it_would_be_rent_exempt() -> TestResult {
    let env = Env::new()?;
    let minimum = u32::try_from(env.svm.minimum_balance_for_rent_exemption(0))?;
    let below = minimum.checked_sub(1).ok_or("underflow")?;
    assert_eq!(charged(minimum, Treasury::Empty, Path::Plain)?, minimum);
    assert_eq!(charged(below, Treasury::Empty, Path::Plain)?, 0);
    Ok(())
}

#[test]
fn no_fee_means_no_withholding_even_for_a_treasury_that_cannot_receive() -> TestResult {
    for treasury in [Treasury::Empty, Treasury::Program] {
        assert_eq!(charged(0, treasury, Path::Plain)?, 0);
    }
    Ok(())
}
