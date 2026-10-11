use anchor_lang::prelude::Pubkey;
use anchor_lang::Discriminator;
use anchor_spl::token_2022::spl_token_2022::instruction as token_ix;
use intent_core::kinds::Intent as CoreIntent;
use intent_core::lifecycle::Status;
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use solana_instruction::Instruction;
use solana_signer::Signer;
use svm_tests::{
    canonical_refund, ed25519_ix, intent_pda, relay_program_path, signature_of, vault_pda, MintExt,
    TestResult,
};

#[path = "hostile/world.rs"]
mod world;

use world::{Mutation, World, VICTIM, WORDS};

include!("hostile/strategies.rs");

const MAX_INSTRUCTIONS: usize = 12;
const END_INDEX_AT: usize = 16;
const BEGIN_INTENT_SLOT: usize = 2;
const END_INTENT_SLOT: usize = 0;
const SIGNED_MESSAGE_AT: usize = 112;
const BEYOND_EXPIRY: i64 = 100_000;

#[derive(Debug, Clone)]
enum Piece {
    Base {
        base: usize,
        take: Option<usize>,
        mutations: Vec<Mutation>,
    },
    Replay {
        pick: usize,
        mutations: Vec<Mutation>,
    },
    Forged {
        claim_victim: bool,
    },
    Donate {
        to: usize,
        amount: u64,
        output: bool,
    },
    Begin {
        pick: usize,
    },
    End {
        pick: usize,
        pay: u8,
    },
}

#[derive(Debug, Clone)]
enum Edit {
    Swap { a: usize, b: usize },
    Duplicate { at: usize },
    Drop { at: usize },
    Relink { at: usize, to: usize },
}

#[derive(Debug, Clone)]
enum Step {
    Compose {
        pieces: Vec<Piece>,
        edits: Vec<Edit>,
        link_any: bool,
    },
    Warp {
        secs: i64,
    },
    Issuer {
        pick: usize,
        freeze: bool,
    },
    Deploy {
        pick: usize,
    },
    Treasury {
        program: bool,
    },
}

fn piece() -> impl Strategy<Value = Piece> {
    prop_oneof![
        10 => (0..64usize, prop::option::weighted(0.3, 0..2usize), prop::collection::vec(mutation(), 0..3))
            .prop_map(|(base, take, mutations)| Piece::Base { base, take, mutations }),
        2 => (0..2usize, prop::collection::vec(mutation(), 0..3))
            .prop_map(|(pick, mutations)| Piece::Replay { pick, mutations }),
        1 => any::<bool>().prop_map(|claim_victim| Piece::Forged { claim_victim }),
        3 => (0..32usize, 1..=400u64, any::<bool>())
            .prop_map(|(to, amount, output)| Piece::Donate { to, amount, output }),
        6 => (0..16usize).prop_map(|pick| Piece::Begin { pick }),
        6 => (0..16usize, 0..4u8).prop_map(|(pick, pay)| Piece::End { pick, pay }),
    ]
}

fn edit() -> impl Strategy<Value = Edit> {
    prop_oneof![
        3 => (0..16usize, 0..16usize).prop_map(|(a, b)| Edit::Swap { a, b }),
        2 => (0..16usize).prop_map(|at| Edit::Duplicate { at }),
        2 => (0..16usize).prop_map(|at| Edit::Drop { at }),
        3 => (0..16usize, 0..20usize).prop_map(|(at, to)| Edit::Relink { at, to }),
    ]
}

fn step() -> impl Strategy<Value = Step> {
    prop_oneof![
        8 => (prop::collection::vec(piece(), 1..7), prop::collection::vec(edit(), 0..4), any::<bool>())
            .prop_map(|(pieces, edits, link_any)| Step::Compose { pieces, edits, link_any }),
        1 => (1..=120i64).prop_map(|secs| Step::Warp { secs }),
        1 => (0..32usize, any::<bool>()).prop_map(|(pick, freeze)| Step::Issuer { pick, freeze }),
        1 => (0..3usize).prop_map(|pick| Step::Deploy { pick }),
        1 => any::<bool>().prop_map(|program| Step::Treasury { program }),
    ]
}

fn mints(token_2022: bool, flavor: usize) -> &'static [MintExt] {
    match (token_2022, flavor) {
        (true, 1) => &[MintExt::InterestBearing, MintExt::Freezable],
        (true, 2) => &[MintExt::ScaledUi, MintExt::Freezable],
        _ => &[MintExt::Freezable],
    }
}

fn set_frozen(world: &mut World, account: &Pubkey, frozen: bool) -> bool {
    let program = world.market.input_program;
    let (input, output) = (world.market.input_mint, world.market.output_mint);
    world
        .env
        .set_frozen(account, &input, program, frozen)
        .is_ok()
        || world
            .env
            .set_frozen(account, &output, program, frozen)
            .is_ok()
}

fn thaw_everything(world: &mut World) {
    for account in world.tokens.clone() {
        set_frozen(world, &account, false);
    }
}

fn is_engine(ix: &Instruction, discriminator: &[u8]) -> bool {
    ix.program_id == intent_engine::ID && ix.data.get(..discriminator.len()) == Some(discriminator)
}

fn is_begin(ix: &Instruction) -> bool {
    is_engine(ix, intent_engine::instruction::BeginFill::DISCRIMINATOR)
}

fn is_end(ix: &Instruction) -> bool {
    is_engine(ix, intent_engine::instruction::EndFill::DISCRIMINATOR)
}

fn intent_at(ix: &Instruction, slot: usize) -> Option<Pubkey> {
    ix.accounts.get(slot).map(|meta| meta.pubkey)
}

fn set_end_index(ix: &mut Instruction, to: usize) -> TestResult {
    let end = END_INDEX_AT.checked_add(2).ok_or("overflow")?;
    if let Some(bytes) = ix.data.get_mut(END_INDEX_AT..end) {
        bytes.copy_from_slice(&u16::try_from(to).unwrap_or(u16::MAX).to_le_bytes());
    }
    Ok(())
}

fn ends_of(ixs: &[Instruction]) -> Vec<usize> {
    ixs.iter()
        .enumerate()
        .filter(|(_, ix)| is_end(ix))
        .map(|(at, _)| at)
        .collect()
}

fn autolink(ixs: &mut [Instruction], link_any: bool) -> TestResult {
    let ends: Vec<(usize, Option<Pubkey>)> = ixs
        .iter()
        .enumerate()
        .filter(|(_, ix)| is_end(ix))
        .map(|(at, ix)| (at, intent_at(ix, END_INTENT_SLOT)))
        .collect();
    for (at, ix) in ixs.iter_mut().enumerate() {
        if !is_begin(ix) {
            continue;
        }
        let intent = intent_at(ix, BEGIN_INTENT_SLOT);
        let own = ends.iter().find(|(end, of)| *end > at && *of == intent);
        let any = ends.iter().find(|(end, _)| *end > at);
        if let Some((end, _)) = if link_any { any.or(own) } else { own.or(any) } {
            set_end_index(ix, *end)?;
        }
    }
    Ok(())
}

fn build(world: &World, piece: &Piece) -> TestResult<Vec<Instruction>> {
    let me = world.attacker.key.pubkey();
    Ok(match piece {
        Piece::Base {
            base,
            take,
            mutations,
        } => {
            let bases = world.bases()?;
            let chosen = bases
                .get(base.checked_rem(bases.len()).ok_or("no bases")?)
                .ok_or("no base")?;
            let mut ixs = match take {
                Some(i) => chosen
                    .get(i.checked_rem(chosen.len()).ok_or("empty base")?)
                    .into_iter()
                    .cloned()
                    .collect(),
                None => chosen.clone(),
            };
            if let Some(last) = ixs.last_mut() {
                world.mutate(last, mutations)?;
            }
            ixs
        }
        Piece::Replay { pick, mutations } => {
            let mut ix = world
                .captured
                .get(
                    pick.checked_rem(world.captured.len())
                        .ok_or("nothing captured")?,
                )
                .ok_or("captured")?
                .clone();
            world.mutate(&mut ix, mutations)?;
            vec![ix]
        }
        Piece::Forged { claim_victim } => {
            let message = world
                .captured
                .first()
                .and_then(|ix| ix.data.get(SIGNED_MESSAGE_AT..))
                .ok_or("no captured message")?
                .to_vec();
            if *claim_victim {
                let victim = world.traders.get(VICTIM).ok_or("no victim")?.key.pubkey();
                vec![
                    solana_ed25519_program::new_ed25519_instruction_with_signature(
                        &message,
                        &signature_of(&world.attacker.key, &message),
                        &victim.to_bytes(),
                    ),
                ]
            } else {
                vec![ed25519_ix(&world.attacker.key, &message)]
            }
        }
        Piece::Begin { pick } => {
            let t = world
                .tracked
                .get(
                    pick.checked_rem(world.tracked.len())
                        .ok_or("nothing tracked")?,
                )
                .ok_or("tracked")?;
            vec![world.env.begin_fill_ix(
                &me,
                &t.owner,
                &world.market,
                t.nonce,
                &world.attacker.input,
                Some(&world.fee_to),
                0,
            )]
        }
        Piece::End { pick, pay } => {
            let t = world
                .tracked
                .get(
                    pick.checked_rem(world.tracked.len())
                        .ok_or("nothing tracked")?,
                )
                .ok_or("tracked")?;
            let now = world.env.now();
            let required = world
                .env
                .intent(&t.owner, t.nonce)
                .ok()
                .and_then(|state| {
                    CoreIntent::decode(state.kind, &state.params)
                        .ok()?
                        .required_out(state.escrowed, now)
                        .ok()
                })
                .unwrap_or(1);
            let amount = match pay {
                0 => required,
                1 => required.saturating_sub(1),
                2 => 0,
                _ => required.saturating_mul(2),
            };
            vec![world.env.end_fill_ix(
                &me,
                &t.owner,
                &world.market,
                t.nonce,
                &t.receiver,
                &world.attacker.output,
                amount,
            )]
        }
        Piece::Donate { to, amount, output } => {
            let (from, mint) = if *output {
                (world.attacker.output, world.market.output_mint)
            } else {
                (world.attacker.input, world.market.input_mint)
            };
            let program = if *output {
                world.market.output_program
            } else {
                world.market.input_program
            };
            let target = *world
                .tokens
                .get(to.checked_rem(world.tokens.len()).ok_or("no tokens")?)
                .ok_or("tokens")?;
            vec![token_ix::transfer_checked(
                &program,
                &from,
                &mint,
                &target,
                &me,
                &[],
                *amount,
                world.env.decimals(&mint)?,
            )?]
        }
    })
}

fn apply(ixs: &mut Vec<Instruction>, edit: &Edit) -> TestResult {
    let len = ixs.len();
    if len == 0 {
        return Ok(());
    }
    let wrap = |i: usize| i.checked_rem(len).ok_or("empty");
    match *edit {
        Edit::Swap { a, b } => ixs.swap(wrap(a)?, wrap(b)?),
        Edit::Duplicate { at } => {
            let at = wrap(at)?;
            if len < MAX_INSTRUCTIONS {
                let copy = ixs.get(at).ok_or("at")?.clone();
                ixs.insert(at.checked_add(1).ok_or("overflow")?, copy);
            }
        }
        Edit::Drop { at } => {
            if len > 1 {
                ixs.remove(wrap(at)?);
            }
        }
        Edit::Relink { at, to } => {
            let reach = len.checked_add(2).ok_or("overflow")?;
            let ends = ends_of(ixs);
            let target = match ends.get(
                to.checked_div(2)
                    .unwrap_or(0)
                    .checked_rem(ends.len().max(1))
                    .ok_or("ends")?,
            ) {
                Some(end) if to.checked_rem(2) == Some(0) => *end,
                _ => to.checked_rem(reach).ok_or("reach")?,
            };
            if let Some(ix) = ixs.get_mut(wrap(at)?) {
                if is_begin(ix) {
                    set_end_index(ix, target)?;
                }
            }
        }
    }
    Ok(())
}

fn compose(world: &mut World, pieces: &[Piece], edits: &[Edit], link_any: bool) -> TestResult {
    let mut ixs = Vec::new();
    for p in pieces {
        ixs.extend(build(world, p)?);
    }
    ixs.truncate(MAX_INSTRUCTIONS);
    autolink(&mut ixs, link_any)?;
    for e in edits {
        apply(&mut ixs, e)?;
    }
    world.submit(ixs)
}

fn deploy_over(world: &mut World, pick: usize) -> TestResult {
    let mut payers: Vec<Pubkey> = world.traders.iter().map(|t| t.key.pubkey()).collect();
    payers.push(world.relayer.pubkey());
    let key = *payers
        .get(pick.checked_rem(payers.len()).ok_or("no payers")?)
        .ok_or("payer")?;
    world
        .env
        .svm
        .add_program_from_file(key, relay_program_path())?;
    Ok(())
}

fn gained(world: &World, key: &Pubkey, before: u64) -> TestResult<u64> {
    Ok(world
        .env
        .lamports(key)
        .checked_sub(before)
        .ok_or_else(|| format!("{key} lost lamports on close"))?)
}

fn break_treasury(world: &mut World, program: bool) -> TestResult {
    let key = world.env.fee_recipient;
    if program {
        world
            .env
            .svm
            .add_program_from_file(key, relay_program_path())?;
    } else {
        world.env.svm.set_account(key, Default::default())?;
    }
    Ok(())
}

fn treasury_takes(world: &World) -> bool {
    let key = world.env.fee_recipient;
    let held = world.env.lamports(&key);
    let size = world.env.svm.get_account(&key).map_or(0, |a| a.data.len());
    !world.is_program(&key)
        && held.saturating_add(u64::from(world::CREATE_FEE))
            >= world.env.svm.minimum_balance_for_rent_exemption(size)
}

fn composed_within_treasury_rules(
    world: &mut World,
    pieces: &[Piece],
    edits: &[Edit],
    link_any: bool,
) -> TestResult {
    let key = world.env.fee_recipient;
    let takes = treasury_takes(world);
    let before = world.env.lamports(&key);
    let tracked = world.tracked.len();
    compose(world, pieces, edits, link_any)?;
    let created = u64::try_from(world.tracked.len().saturating_sub(tracked))?;
    let gained = world
        .env
        .lamports(&key)
        .checked_sub(before)
        .ok_or("the treasury lost lamports")?;
    let owed = if takes {
        created.saturating_mul(u64::from(world::CREATE_FEE))
    } else {
        0
    };
    if gained != owed {
        return Err(format!(
            "the treasury gained {gained} for {created} new intents, owed {owed} (takes fees: {takes})"
        )
        .into());
    }
    Ok(())
}

fn liveness(world: &mut World) -> TestResult {
    let now = world.env.now().checked_add(BEYOND_EXPIRY).ok_or("clock")?;
    world.env.set_now(now);
    let cranker = world.env.funded()?;
    let crank = cranker.pubkey();
    let fee_payer = world.env.funded()?;
    let tracked: Vec<(Pubkey, u64)> = world.tracked.iter().map(|t| (t.owner, t.nonce)).collect();
    for (owner, nonce) in tracked {
        let Ok(state) = world.env.intent(&owner, nonce) else {
            continue;
        };
        let refund = canonical_refund(&owner, &world.market);
        if state.status == Status::Filling as u8 {
            return Err(format!("intent {nonce} of {owner} is stuck mid-fill").into());
        }
        if state.status == Status::Open as u8 {
            let ix = world
                .env
                .expire_ix(&crank, &owner, &world.market, nonce, &refund);
            world
                .env
                .send(&cranker, &[ix], &[])
                .map_err(|e| format!("intent {nonce} of {owner} cannot be expired: {e:?}"))?;
        }
        let state = world.env.intent(&owner, nonce)?;
        let intent = intent_pda(&owner, nonce);
        let bounty = u64::from(state.bounty);
        let rent = world
            .env
            .lamports(&intent)
            .checked_add(world.env.lamports(&vault_pda(&intent)))
            .and_then(|held| held.checked_sub(bounty))
            .ok_or("overflow")?;
        let forfeits = world.is_program(&state.rent_payer);
        let (crank_before, payer_before) = (
            world.env.lamports(&crank),
            world.env.lamports(&state.rent_payer),
        );
        let ix = world.env.close_ix_with(
            &crank,
            &owner,
            &state.rent_payer,
            &world.market,
            nonce,
            &refund,
        );
        world
            .env
            .send(&fee_payer, &[ix], &[&cranker])
            .map_err(|e| format!("intent {nonce} of {owner} cannot be closed: {e:?}"))?;
        let to_crank = gained(world, &crank, crank_before)?;
        let to_payer = gained(world, &state.rent_payer, payer_before)?;
        let expected = if forfeits {
            (bounty.checked_add(rent).ok_or("overflow")?, 0)
        } else {
            (bounty, rent)
        };
        if (to_crank, to_payer) != expected {
            return Err(format!(
                "intent {nonce} of {owner} paid cranker {to_crank} and rent payer {to_payer}, expected {expected:?}"
            )
            .into());
        }
        if world.env.exists(&intent) || world.env.exists(&vault_pda(&intent)) {
            return Err(format!("intent {nonce} of {owner} left an account behind").into());
        }
    }
    Ok(())
}

fn run(token_2022: bool, flavor: usize, steps: &[Step]) -> TestResult {
    let program = if token_2022 {
        anchor_spl::token_2022::ID
    } else {
        anchor_spl::token::ID
    };
    let mut world = World::with_mints(program, mints(token_2022, flavor))?;
    for (n, s) in steps.iter().enumerate() {
        match s {
            Step::Compose {
                pieces,
                edits,
                link_any,
            } => composed_within_treasury_rules(&mut world, pieces, edits, *link_any),
            Step::Treasury { program } => break_treasury(&mut world, *program),
            Step::Warp { secs } => {
                let now = world.env.now().checked_add(*secs).ok_or("clock")?;
                world.env.set_now(now);
                Ok(())
            }
            Step::Deploy { pick } => deploy_over(&mut world, *pick),
            Step::Issuer { pick, freeze } => {
                let target = *world
                    .tokens
                    .get(pick.checked_rem(world.tokens.len()).ok_or("no tokens")?)
                    .ok_or("tokens")?;
                set_frozen(&mut world, &target, *freeze);
                Ok(())
            }
        }
        .map_err(|e| format!("step {n} {s:?}: {e}"))?;
    }
    thaw_everything(&mut world);
    liveness(&mut world).map_err(|e| format!("after {} steps: {e}", steps.len()).into())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(
        std::env::var("COMPOSER_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(48)
    ))]

    #[test]
    fn composed_transactions_cannot_break_any_invariant(
        token_2022 in any::<bool>(),
        flavor in 0..3usize,
        steps in prop::collection::vec(step(), 1..30),
    ) {
        run(token_2022, flavor, &steps).map_err(|e| TestCaseError::fail(e.to_string()))?;
    }
}

#[test]
fn the_honest_agent_orders_the_fuzzer_builds_succeed() -> TestResult {
    let mut world = World::new(anchor_spl::token::ID)?;
    let attacker = world.attacker.key.insecure_clone();
    let bases = world.bases()?;
    let honest: Vec<_> = bases
        .iter()
        .filter(|b| {
            b.iter().any(|ix| {
                is_engine(
                    ix,
                    intent_engine::instruction::CreateIntentByAgent::DISCRIMINATOR,
                ) && world::AGENT_NONCES
                    .iter()
                    .any(|n| ix.data.windows(8).any(|w| w == n.to_le_bytes()))
            })
        })
        .collect();
    assert_eq!(honest.len(), world::AGENT_NONCES.len());
    for (n, base) in honest.into_iter().take(2).enumerate() {
        world
            .env
            .send(&attacker, base, &[])
            .map_err(|e| format!("honest agent order {n} refused: {e:?}"))?;
    }
    Ok(())
}
