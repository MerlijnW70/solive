use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use intent_core::kinds::{attested_result, Kind};
use intent_engine::errors::EngineError;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    anchor_error_at, attestation_message, ed25519_ix, engine_error_at, intent_pda, load, vault_pda,
    Env, IntentSpec, Market, TestResult, Trader, DOMAIN, START_TS,
};

const PROGRAM: Pubkey = anchor_spl::token::ID;
const FUNDED: u64 = 1_000;
const ESCROW: u64 = 400;
const SMALL: u64 = 10;

struct World {
    env: Env,
    market: Market,
    victim: Trader,
    attacker: Trader,
    judge: Keypair,
    fee_to: Pubkey,
    loot: Pubkey,
}

fn attested_spec(nonce: u64, amount_in: u64, attestor: &Pubkey) -> TestResult<IntentSpec> {
    Ok(IntentSpec {
        nonce,
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in,
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
    let victim = env.trader(&market, FUNDED)?;
    let attacker = env.trader(&market, FUNDED)?;
    let judge = Keypair::new();
    let fee_to = env.fee_account(&market)?;
    env.create_intent(
        &victim,
        &market,
        &attested_spec(0, ESCROW, &judge.pubkey())?,
    )?;
    env.create_intent(
        &attacker,
        &market,
        &attested_spec(0, SMALL, &attacker.key.pubkey())?,
    )?;
    let loot = env.create_token_account(&market.input_mint, &attacker.key.pubkey(), PROGRAM)?;
    Ok(World {
        env,
        market,
        victim,
        attacker,
        judge,
        fee_to,
        loot,
    })
}

impl World {
    fn victim_intent(&self) -> Pubkey {
        intent_pda(&self.victim.key.pubkey(), 0)
    }

    fn attacker_intent(&self) -> Pubkey {
        intent_pda(&self.attacker.key.pubkey(), 0)
    }

    fn release_through(&self, intent: &Pubkey, amount_in: u64) -> [Instruction; 2] {
        let message = attestation_message(
            DOMAIN,
            &self.attacker.key.pubkey(),
            intent,
            &self.loot,
            amount_in,
            15,
        );
        let mut fill = self.env.fill_attested_ix(
            &self.attacker.key.pubkey(),
            &self.victim.key.pubkey(),
            &self.market,
            0,
            &self.loot,
            Some(&self.fee_to),
            15,
        );
        for meta in &mut fill.accounts {
            if meta.pubkey == self.victim_intent() {
                meta.pubkey = *intent;
            }
        }
        [ed25519_ix(&self.attacker.key, &message), fill]
    }

    fn send(&mut self, ixs: &[Instruction]) -> Option<TransactionError> {
        let attacker = self.attacker.key.insecure_clone();
        self.env.send(&attacker, ixs, &[]).err()
    }

    fn victim_untouched(&self) -> TestResult {
        assert_eq!(self.env.balance(&vault_pda(&self.victim_intent()))?, ESCROW);
        assert_eq!(self.env.balance(&self.loot)?, 0);
        Ok(())
    }
}

#[test]
fn a_forged_copy_of_an_escrow_naming_the_attacker_as_judge_is_refused_for_its_owner() -> TestResult
{
    let mut w = world()?;
    let mut copy = w
        .env
        .svm
        .get_account(&w.victim_intent())
        .ok_or("victim intent missing")?;
    let mut state: intent_engine::state::Intent = load(&w.env.svm, &w.victim_intent())?;
    state.params = attested_spec(0, ESCROW, &w.attacker.key.pubkey())?.params;
    let body = copy
        .data
        .get_mut(8..8 + core::mem::size_of::<intent_engine::state::Intent>())
        .ok_or("intent too short")?;
    body.copy_from_slice(bytemuck::bytes_of(&state));
    copy.owner = Pubkey::new_unique();
    let forged = Pubkey::new_unique();
    w.env.svm.set_account(forged, copy)?;
    let ixs = w.release_through(&forged, ESCROW);
    assert_eq!(
        w.send(&ixs),
        Some(anchor_error_at(1, ErrorCode::AccountOwnedByWrongProgram))
    );
    w.victim_untouched()
}

#[test]
fn the_attackers_own_escrow_cannot_stand_in_for_the_victims_beside_the_victims_vault() -> TestResult
{
    let mut w = world()?;
    let own = w.attacker_intent();
    let ixs = w.release_through(&own, SMALL);
    assert_eq!(
        w.send(&ixs),
        Some(anchor_error_at(1, ErrorCode::ConstraintSeeds))
    );
    w.victim_untouched()?;
    assert_eq!(w.env.balance(&vault_pda(&own))?, SMALL);
    Ok(())
}

#[test]
fn only_the_judge_the_victims_escrow_names_releases_it() -> TestResult {
    let mut w = world()?;
    let victim = w.victim_intent();
    let ixs = w.release_through(&victim, ESCROW);
    assert_eq!(
        w.send(&ixs),
        Some(engine_error_at(1, EngineError::SigPubkey))
    );
    w.victim_untouched()?;
    let message = attestation_message(DOMAIN, &w.judge.pubkey(), &victim, &w.loot, ESCROW, 15);
    let [_, fill] = w.release_through(&victim, ESCROW);
    let judge = w.judge.insecure_clone();
    let paid = w.send(&[ed25519_ix(&judge, &message), fill]);
    assert_eq!(paid, None);
    assert!(w.env.balance(&w.loot)? > 0);
    Ok(())
}
