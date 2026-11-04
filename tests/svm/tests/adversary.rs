use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
#[path = "hostile/world.rs"]
mod world;

use solana_signer::Signer;
use svm_tests::{intent_pda, TestResult};
use world::{Mutation, World, AGENT_NONCES, VICTIM, WORDS};

include!("hostile/strategies.rs");

#[derive(Debug, Clone)]
enum Step {
    Attack {
        base: usize,
        mutations: Vec<Mutation>,
    },
    Warp {
        secs: i64,
    },
}

fn step() -> impl Strategy<Value = Step> {
    prop_oneof![
        8 => (0..64usize, prop::collection::vec(mutation(), 0..4))
            .prop_map(|(base, mutations)| Step::Attack { base, mutations }),
        1 => (1..=120i64).prop_map(|secs| Step::Warp { secs }),
    ]
}

fn run(token_2022: bool, steps: &[Step]) -> TestResult {
    let program = if token_2022 {
        anchor_spl::token_2022::ID
    } else {
        anchor_spl::token::ID
    };
    let mut world = World::new(program)?;
    for (n, s) in steps.iter().enumerate() {
        match s {
            Step::Attack { base, mutations } => world.attack(*base, mutations),
            Step::Warp { secs } => {
                let now = world.env.now().checked_add(*secs).ok_or("clock")?;
                world.env.set_now(now);
                Ok(())
            }
        }
        .map_err(|e| format!("step {n} {s:?}: {e}"))?;
    }
    Ok(())
}

#[test]
fn an_agent_closing_its_own_filled_intent_takes_back_only_the_rent_it_paid() -> TestResult {
    let mut world = World::new(anchor_spl::token::ID)?;
    let me = world.attacker.key.pubkey();
    let start = world.env.lamports(&me);
    world.attack(30, &[])?;
    world.attack(30, &[])?;
    world.attack(35, &[Mutation::Account { slot: 19, pick: 0 }])?;
    let [first, ..] = AGENT_NONCES;
    let intent = intent_pda(&world.trader(VICTIM)?.key.pubkey(), first);
    if world.env.exists(&intent) {
        return Err("the agent intent was not closed".into());
    }
    if world.env.lamports(&me) >= start || !world.own_rent.is_empty() {
        return Err("the agent came out ahead in lamports".into());
    }
    Ok(())
}

#[test]
fn an_attacker_naming_itself_rent_payer_cannot_close_a_trader_intent() -> TestResult {
    let mut world = World::new(anchor_spl::token::ID)?;
    let me = world.attacker.key.pubkey();
    let intent = intent_pda(&world.trader(0)?.key.pubkey(), 0);
    world.attack(0, &[])?;
    let before = world.env.lamports(&me);
    world.attack(5, &[Mutation::Account { slot: 19, pick: 0 }])?;
    let after = world.env.lamports(&me);
    if !world.env.exists(&intent) {
        return Err("the close named the attacker as rent payer and went through".into());
    }
    if after > before || before.saturating_sub(after) > 5_000 {
        return Err(format!("attacker lamports moved from {before} to {after}").into());
    }
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(
        std::env::var("ADVERSARY_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(64)
    ))]

    #[test]
    fn a_signer_without_authority_cannot_break_any_invariant(
        token_2022 in any::<bool>(),
        steps in prop::collection::vec(step(), 1..60),
    ) {
        run(token_2022, &steps).map_err(|e| TestCaseError::fail(e.to_string()))?;
    }
}
