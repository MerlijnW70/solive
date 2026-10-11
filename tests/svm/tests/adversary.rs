use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
#[path = "hostile/world.rs"]
mod world;

use svm_tests::TestResult;
use world::{Mutation, World, WORDS};

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
