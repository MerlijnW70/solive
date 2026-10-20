use anchor_lang::prelude::Pubkey;
use core::mem::offset_of;
use intent_core::kinds::{attested_result, Kind};
use intent_engine::errors::EngineError;
use intent_engine::events::MintCapSet;
use intent_engine::state::{MintCap, MINT_CAP_SEED};
use litesvm::types::TransactionMetadata;
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    attestation_proof_message, close_legacy_ix, committee_batch_ix, config_pda, cosign_batch_ix,
    cosign_ix, create_committee_ix, ed25519_ix, engine_error, engine_ix, event_authority, events,
    intent_pda, load, partner_ext, pda, proof_digest, sorted_members, split_commit, split_digest,
    swap_spec, vault_pda, CommitteeFill, Env, IntentSpec, Market, MintExt, Solver, TestResult,
    Trader, DOMAIN, START_TS,
};

const PROGRAM: Pubkey = anchor_spl::token::ID;
const FUNDED: u64 = 10_000_000;
const MAX: u64 = 100_000;
const WINDOW: u64 = u64::MAX / 2;
const SECS: u32 = 3_600;
const TTL: i64 = 600;
const SPEC: [u8; 32] = [0x5d; 32];
const PARTNER_BPS: u16 = 50;
const WEIGHTS: [u16; 2] = [6_000, 4_000];

type Sent = Result<TransactionMetadata, TransactionError>;

struct Panel {
    members: Vec<Keypair>,
    keys: Vec<Pubkey>,
    address: Pubkey,
}

struct World {
    env: Env,
    market: Market,
    trader: Trader,
    solver: Solver,
    fee_to: Pubkey,
    attestor: Keypair,
    panel: Panel,
    partner: Pubkey,
    partner_to: Pubkey,
    coauthors: [Keypair; 2],
}

fn mint_cap_pda(mint: &Pubkey) -> Pubkey {
    pda(&[MINT_CAP_SEED, mint.as_ref()])
}

fn set_mint_cap_ix(admin: &Pubkey, mint: &Pubkey, total_limit: u64) -> Instruction {
    engine_ix(
        intent_engine::accounts::SetMintCap {
            admin: *admin,
            payer: *admin,
            config: config_pda(),
            mint: *mint,
            mint_cap: mint_cap_pda(mint),
            system_program: anchor_lang::system_program::ID,
            event_authority: event_authority(),
            program: intent_engine::ID,
        },
        intent_engine::instruction::SetMintCap {
            max_per_order: MAX,
            window_cap: WINDOW,
            window_secs: SECS,
            total_limit,
        },
    )
}

fn caps_required_ix(admin: &Pubkey, required: bool) -> Instruction {
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

fn world() -> TestResult<World> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(PROGRAM, &[MintExt::Freezable], PROGRAM, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let solver = env.solver(&market, FUNDED)?;
    let fee_to = env.fee_account(&market)?;
    let members = sorted_members(2);
    let keys: Vec<Pubkey> = members.iter().map(Signer::pubkey).collect();
    let payer = env.funded()?;
    let (ix, address) = create_committee_ix(&payer.pubkey(), &keys, 2, &Pubkey::new_unique())?;
    env.send(&payer, &[ix], &[])?;
    let partner = Pubkey::new_unique();
    let partner_to = env.create_ata(&partner, &market.input_mint, PROGRAM)?;
    env.set_frozen(&partner_to, &market.input_mint, PROGRAM, true)?;
    env.partner_to = Some(partner_to);
    let coauthors = [Keypair::new(), Keypair::new()];
    for c in &coauthors {
        env.create_ata(&c.pubkey(), &market.input_mint, PROGRAM)?;
    }
    Ok(World {
        env,
        market,
        trader,
        solver,
        fee_to,
        attestor: Keypair::new(),
        panel: Panel {
            members,
            keys,
            address,
        },
        partner,
        partner_to,
        coauthors,
    })
}

fn capped_world(total_limit: u64) -> TestResult<World> {
    let mut w = world()?;
    w.limit(total_limit)??;
    w.require(true)??;
    w.env.mint_cap = Some(w.cap());
    Ok(w)
}

impl World {
    fn admin(&self) -> Keypair {
        self.env.authority.insecure_clone()
    }

    fn owner(&self) -> Pubkey {
        self.trader.key.pubkey()
    }

    fn cap(&self) -> Pubkey {
        mint_cap_pda(&self.market.input_mint)
    }

    fn limit(&mut self, total_limit: u64) -> TestResult<Sent> {
        let admin = self.admin();
        let ix = set_mint_cap_ix(&admin.pubkey(), &self.market.input_mint, total_limit);
        Ok(self.env.send(&admin, &[ix], &[]))
    }

    fn require(&mut self, required: bool) -> TestResult<Sent> {
        let admin = self.admin();
        let ix = caps_required_ix(&admin.pubkey(), required);
        Ok(self.env.send(&admin, &[ix], &[]))
    }

    fn state(&self) -> TestResult<MintCap> {
        load(&self.env.svm, &self.cap())
    }

    fn outstanding(&self) -> TestResult<u64> {
        Ok(self.state()?.outstanding)
    }

    fn vault(&self, nonce: u64) -> TestResult<u64> {
        self.env
            .balance(&vault_pda(&intent_pda(&self.owner(), nonce)))
    }

    fn capped(&self, nonce: u64) -> TestResult<u64> {
        Ok(self.env.intent(&self.owner(), nonce)?.capped)
    }

    fn open(&self, nonce: u64) -> bool {
        self.env.exists(&intent_pda(&self.owner(), nonce))
    }

    fn ext(&self, partnered: bool) -> Vec<u8> {
        if partnered {
            partner_ext(&self.partner, PARTNER_BPS)
        } else {
            Vec::new()
        }
    }

    fn swap(&self, nonce: u64, amount: u64, partnered: bool) -> TestResult<IntentSpec> {
        Ok(IntentSpec {
            expires_at: self.env.now().saturating_add(TTL),
            ext: self.ext(partnered),
            ..swap_spec(nonce, amount)?
        })
    }

    fn judged(
        &self,
        nonce: u64,
        amount: u64,
        attestor: &Pubkey,
        partnered: bool,
    ) -> TestResult<IntentSpec> {
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
            ..self.swap(nonce, amount, partnered)?
        })
    }

    fn create(&mut self, spec: &IntentSpec) -> Sent {
        let ix = self.env.create_intent_ix(&self.trader, &self.market, spec);
        let key = self.trader.key.insecure_clone();
        self.env.send(&key, &[ix], &[])
    }

    fn cancel(&mut self, nonce: u64) -> Sent {
        let owner = self.owner();
        let ix = self
            .env
            .cancel_ix(&owner, &self.market, nonce, &self.trader.input);
        let key = self.trader.key.insecure_clone();
        self.env.send(&key, &[ix], &[])
    }

    fn expire(&mut self, nonce: u64) -> Sent {
        let owner = self.owner();
        let cranker = self.solver.key.insecure_clone();
        let ix = self.env.expire_ix(
            &cranker.pubkey(),
            &owner,
            &self.market,
            nonce,
            &self.trader.input,
        );
        self.env.send(&cranker, &[ix], &[])
    }

    fn close(&mut self, nonce: u64) -> Sent {
        let owner = self.owner();
        let ix = self
            .env
            .close_ix(&owner, &self.market, nonce, &self.trader.input);
        let key = self.trader.key.insecure_clone();
        self.env.send(&key, &[ix], &[])
    }

    fn fill(&mut self, nonce: u64) -> Sent {
        self.aim(nonce);
        let owner = self.owner();
        let ix = self.env.fill_ix(
            &self.solver,
            &owner,
            &self.market,
            nonce,
            &self.trader.receiver,
            Some(&self.fee_to),
            10,
        );
        let solver = self.solver.key.insecure_clone();
        self.env.send(&solver, &[ix], &[])
    }

    fn flash(&mut self, nonce: u64) -> Sent {
        self.aim(nonce);
        let owner = self.owner();
        let solver = self.solver.key.insecure_clone();
        let begin = self.env.begin_fill_ix(
            &solver.pubkey(),
            &owner,
            &self.market,
            nonce,
            &self.solver.input,
            Some(&self.fee_to),
            1,
        );
        let end = self.env.end_fill_ix(
            &solver.pubkey(),
            &owner,
            &self.market,
            nonce,
            &self.trader.receiver,
            &self.solver.output,
            10,
        );
        self.env.send(&solver, &[begin, end], &[])
    }

    fn release(&mut self, nonce: u64) -> TestResult<Sent> {
        self.aim(nonce);
        let owner = self.owner();
        let intent = intent_pda(&owner, nonce);
        let payee = self.solver.input;
        let amount = self.env.fill_amount(&owner, nonce);
        let message = attestation_proof_message(
            DOMAIN,
            &self.attestor.pubkey(),
            &intent,
            &payee,
            amount,
            1,
            SPEC,
        );
        let solver = self.solver.key.insecure_clone();
        let fill = self.env.fill_attested_ix(
            &solver.pubkey(),
            &owner,
            &self.market,
            nonce,
            &payee,
            Some(&self.fee_to),
            1,
        );
        Ok(self
            .env
            .send(&solver, &[ed25519_ix(&self.attestor, &message), fill], &[]))
    }

    fn recipients(&self) -> Vec<Pubkey> {
        self.coauthors.iter().map(Signer::pubkey).collect()
    }

    fn split(&mut self, nonce: u64) -> TestResult<Sent> {
        self.aim(nonce);
        let owner = self.owner();
        let intent = intent_pda(&owner, nonce);
        let amount = self.env.fill_amount(&owner, nonce);
        let recipients = self.recipients();
        let digest = split_digest(
            DOMAIN,
            &intent,
            amount,
            1,
            SPEC,
            split_commit(&recipients, &WEIGHTS),
        );
        let signers: Vec<&Keypair> = self
            .coauthors
            .iter()
            .chain(std::iter::once(&self.attestor))
            .collect();
        let cosign = cosign_batch_ix(&signers, &digest)?;
        let solver = self.solver.key.insecure_clone();
        let fill = self.env.fill_attested_split_ix(
            &solver.pubkey(),
            &owner,
            &self.market,
            nonce,
            &recipients,
            &WEIGHTS,
            Some(&self.fee_to),
            1,
        );
        Ok(self.env.send(&solver, &[cosign, fill], &[]))
    }

    fn committee_fill<'a>(
        &'a self,
        solver: &'a Pubkey,
        owner: &'a Pubkey,
        nonce: u64,
    ) -> CommitteeFill<'a> {
        CommitteeFill {
            solver,
            owner,
            market: &self.market,
            nonce,
            fee_to: Some(&self.fee_to),
            committee: &self.panel.address,
            signers: 0b11,
            result: 1,
        }
    }

    fn aim(&mut self, nonce: u64) {
        let partner = self
            .env
            .intent(&self.owner(), nonce)
            .map(|intent| intent.partner)
            .unwrap_or_default();
        self.env.partner_to = (partner != Pubkey::default()).then_some(self.partner_to);
    }

    fn committee_release(&mut self, nonce: u64) -> TestResult<Sent> {
        self.aim(nonce);
        let owner = self.owner();
        let intent = intent_pda(&owner, nonce);
        let payee = self.solver.input;
        let amount = self.env.fill_amount(&owner, nonce);
        let digest = proof_digest(DOMAIN, &intent, &payee, amount, 1, SPEC);
        let signers: Vec<&Keypair> = self.panel.members.iter().collect();
        let batch = committee_batch_ix(&self.panel.keys, &signers, &digest)?;
        let solver = self.solver.key.insecure_clone();
        let fill = self.env.fill_attested_committee_ix(
            &self.committee_fill(&solver.pubkey(), &owner, nonce),
            &payee,
        );
        Ok(self.env.send(&solver, &[batch, fill], &[]))
    }

    fn committee_split(&mut self, nonce: u64) -> TestResult<Sent> {
        self.aim(nonce);
        let owner = self.owner();
        let intent = intent_pda(&owner, nonce);
        let amount = self.env.fill_amount(&owner, nonce);
        let recipients = self.recipients();
        let digest = split_digest(
            DOMAIN,
            &intent,
            amount,
            1,
            SPEC,
            split_commit(&recipients, &WEIGHTS),
        );
        let listed: Vec<Pubkey> = recipients
            .iter()
            .chain(self.panel.keys.iter())
            .copied()
            .collect();
        let signers: Vec<&Keypair> = self
            .coauthors
            .iter()
            .chain(self.panel.members.iter())
            .collect();
        let cosign = cosign_ix(&listed, &signers, &digest)?;
        let solver = self.solver.key.insecure_clone();
        let fill = self.env.fill_attested_split_committee_ix(
            &self.committee_fill(&solver.pubkey(), &owner, nonce),
            &recipients,
            &WEIGHTS,
        );
        Ok(self.env.send(&solver, &[cosign, fill], &[]))
    }

    fn exit_lowers_by_what_left(&mut self, nonce: u64, exit: Exit) -> TestResult<u64> {
        let before = (self.outstanding()?, self.vault(nonce)?);
        match exit {
            Exit::Cancel => self.cancel(nonce)?,
            Exit::Expire => self.expire(nonce)?,
            Exit::Close => self.close(nonce)?,
            Exit::Fill => self.fill(nonce)?,
            Exit::Flash => self.flash(nonce)?,
            Exit::Release => self.release(nonce)??,
            Exit::Split => self.split(nonce)??,
            Exit::CommitteeRelease => self.committee_release(nonce)??,
            Exit::CommitteeSplit => self.committee_split(nonce)??,
        };
        let after = if self.open(nonce) {
            self.vault(nonce)?
        } else {
            0
        };
        let left = before.1.checked_sub(after).ok_or("the vault grew")?;
        let lowered = before
            .0
            .checked_sub(self.outstanding()?)
            .ok_or("the outstanding amount grew")?;
        assert_eq!(
            lowered, left,
            "{exit:?} lowers the outstanding amount by exactly what left the vault"
        );
        if self.open(nonce) {
            assert_eq!(self.capped(nonce)?, after, "{exit:?}");
        }
        Ok(left)
    }
}

#[derive(Debug, Clone, Copy)]
enum Exit {
    Cancel,
    Expire,
    Close,
    Fill,
    Flash,
    Release,
    Split,
    CommitteeRelease,
    CommitteeSplit,
}

#[test]
fn a_create_that_would_pass_the_total_limit_is_refused() -> TestResult {
    let mut w = capped_world(250_000)?;
    let a = w.swap(0, MAX, false)?;
    w.create(&a)?;
    let b = w.swap(1, MAX, false)?;
    w.create(&b)?;
    assert_eq!(w.outstanding()?, 2 * MAX);
    let over = w.swap(2, MAX, false)?;
    assert_eq!(
        w.create(&over).err(),
        Some(engine_error(EngineError::MintCapTotal))
    );
    assert!(!w.open(2));
    assert_eq!(w.outstanding()?, 2 * MAX);
    let fits = w.swap(2, 50_000, false)?;
    w.create(&fits)?;
    assert_eq!(w.outstanding()?, 250_000);
    assert_eq!(w.capped(2)?, 50_000);
    let one = w.swap(3, 1, false)?;
    assert_eq!(
        w.create(&one).err(),
        Some(engine_error(EngineError::MintCapTotal))
    );
    w.cancel(0)?;
    assert_eq!(w.outstanding()?, 150_000);
    let again = w.swap(3, MAX, false)?;
    w.create(&again)?;
    assert_eq!(w.outstanding()?, 250_000);
    assert_eq!(w.env.balance(&w.trader.input)?, FUNDED - 250_000);
    Ok(())
}

#[test]
fn a_total_limit_of_zero_imposes_none() -> TestResult {
    let mut w = capped_world(0)?;
    for nonce in 0..8 {
        let spec = w.swap(nonce, MAX, false)?;
        w.create(&spec)?;
    }
    assert_eq!(w.outstanding()?, 8 * MAX);
    w.limit(8 * MAX)??;
    let over = w.swap(8, 1, false)?;
    assert_eq!(
        w.create(&over).err(),
        Some(engine_error(EngineError::MintCapTotal))
    );
    w.limit(0)??;
    w.create(&over)?;
    assert_eq!(w.outstanding()?, 8 * MAX + 1);
    Ok(())
}

#[test]
fn set_mint_cap_sets_the_total_limit_and_keeps_the_outstanding_amount() -> TestResult {
    let mut w = capped_world(0)?;
    let spec = w.swap(0, MAX, false)?;
    w.create(&spec)?;
    let meta = w.limit(5 * MAX)??;
    let state = w.state()?;
    assert_eq!((state.total_limit, state.outstanding), (5 * MAX, MAX));
    let set = events::<MintCapSet>(&meta);
    let event = set.first().ok_or("no event")?;
    assert_eq!((event.total_limit, event.outstanding), (5 * MAX, MAX));
    w.limit(MAX / 2)??;
    let state = w.state()?;
    assert_eq!((state.total_limit, state.outstanding), (MAX / 2, MAX));
    Ok(())
}

#[test]
fn cancel_expire_and_close_lower_the_outstanding_amount_by_what_left() -> TestResult {
    let mut w = capped_world(0)?;
    for (nonce, amount) in [(0, 10_000), (1, 20_000), (2, 30_000)] {
        let spec = w.swap(nonce, amount, false)?;
        w.create(&spec)?;
    }
    assert_eq!(w.outstanding()?, 60_000);
    assert_eq!(w.exit_lowers_by_what_left(0, Exit::Cancel)?, 10_000);
    assert_eq!(w.exit_lowers_by_what_left(0, Exit::Close)?, 0);
    w.env.set_now(START_TS + TTL);
    assert_eq!(w.exit_lowers_by_what_left(1, Exit::Expire)?, 20_000);
    assert_eq!(w.exit_lowers_by_what_left(1, Exit::Close)?, 0);
    assert_eq!(w.outstanding()?, 30_000);
    let key = w.trader.key.insecure_clone();
    let vault = vault_pda(&intent_pda(&w.owner(), 2));
    w.env.transfer(
        &key,
        &w.trader.input,
        &w.market.input_mint,
        &vault,
        PROGRAM,
        7,
    )?;
    w.expire(2)?;
    assert_eq!(
        w.outstanding()?,
        0,
        "a donation to a vault is never counted"
    );
    assert_eq!(w.capped(2)?, 0);
    w.close(2)?;
    assert_eq!(w.outstanding()?, 0);
    Ok(())
}

#[test]
fn fills_lower_the_outstanding_amount_by_what_left_including_partial_fills() -> TestResult {
    let mut w = capped_world(0)?;
    let plain = w.swap(0, 40_000, false)?;
    w.create(&plain)?;
    let partnered = w.swap(1, 50_000, true)?;
    w.create(&partnered)?;
    let flash = w.swap(2, 60_000, false)?;
    w.create(&flash)?;
    let flash_partnered = w.swap(3, 70_000, true)?;
    w.create(&flash_partnered)?;
    assert_eq!(w.outstanding()?, 220_000);
    assert_eq!(w.exit_lowers_by_what_left(0, Exit::Fill)?, 40_000);
    let paid = w.exit_lowers_by_what_left(1, Exit::Fill)?;
    let kept = w.vault(1)?;
    assert!(kept > 0, "the withheld partner fee stays in the vault");
    assert_eq!(paid + kept, 50_000);
    assert_eq!(w.exit_lowers_by_what_left(2, Exit::Flash)?, 60_000);
    let flashed = w.exit_lowers_by_what_left(3, Exit::Flash)?;
    let flash_kept = w.vault(3)?;
    assert!(flash_kept > 0);
    assert_eq!(flashed + flash_kept, 70_000);
    assert_eq!(w.outstanding()?, kept + flash_kept);
    assert_eq!(w.exit_lowers_by_what_left(1, Exit::Close)?, kept);
    assert_eq!(w.exit_lowers_by_what_left(3, Exit::Close)?, flash_kept);
    assert_eq!(w.outstanding()?, 0);
    assert_eq!(w.env.balance(&w.partner_to)?, 0);
    Ok(())
}

#[test]
fn releases_and_splits_lower_the_outstanding_amount_by_what_left() -> TestResult {
    let mut w = capped_world(0)?;
    let attestor = w.attestor.pubkey();
    let panel = w.panel.address;
    let specs = [
        (0, attestor, false, Exit::Release),
        (1, attestor, true, Exit::Release),
        (2, attestor, false, Exit::Split),
        (3, attestor, true, Exit::Split),
        (4, panel, false, Exit::CommitteeRelease),
        (5, panel, true, Exit::CommitteeRelease),
        (6, panel, false, Exit::CommitteeSplit),
        (7, panel, true, Exit::CommitteeSplit),
    ];
    let amount = |nonce: u64| 10_000 * (nonce + 1);
    for (nonce, judge, partnered, _) in specs {
        let spec = w.judged(nonce, amount(nonce), &judge, partnered)?;
        w.create(&spec)?;
    }
    assert_eq!(w.outstanding()?, 360_000);
    for (nonce, _, partnered, exit) in specs {
        let left = w.exit_lowers_by_what_left(nonce, exit)?;
        let kept = w.vault(nonce)?;
        assert_eq!(left + kept, amount(nonce), "{exit:?}");
        assert_eq!(kept > 0, partnered, "{exit:?}");
        assert_eq!(w.exit_lowers_by_what_left(nonce, Exit::Close)?, kept);
    }
    assert_eq!(w.outstanding()?, 0);
    Ok(())
}

#[test]
fn an_exit_of_a_counted_intent_needs_its_mint_cap() -> TestResult {
    let mut w = world()?;
    let uncounted = w.swap(0, MAX, false)?;
    w.create(&uncounted)?;
    w.limit(0)??;
    w.require(true)??;
    w.env.mint_cap = Some(w.cap());
    let counted = w.swap(1, MAX, false)?;
    w.create(&counted)?;
    assert_eq!((w.capped(0)?, w.capped(1)?), (0, MAX));
    assert_eq!(w.outstanding()?, MAX);
    w.env.mint_cap = None;
    w.cancel(0)?;
    assert_eq!(w.outstanding()?, MAX);
    assert_eq!(
        w.cancel(1).err(),
        Some(engine_error(EngineError::MintCapMissing))
    );
    let other = w.env.market(PROGRAM, &[], PROGRAM, &[])?;
    let admin = w.admin();
    let ix = set_mint_cap_ix(&admin.pubkey(), &other.input_mint, 0);
    w.env.send(&admin, &[ix], &[])?;
    w.env.mint_cap = Some(mint_cap_pda(&other.input_mint));
    assert_eq!(
        w.cancel(1).err(),
        Some(engine_error(EngineError::MintCapMismatch))
    );
    w.env.mint_cap = Some(w.cap());
    w.cancel(1)?;
    assert_eq!(w.outstanding()?, 0);
    Ok(())
}

#[test]
fn a_counted_intent_returns_its_amount_after_caps_are_lifted() -> TestResult {
    let mut w = capped_world(0)?;
    let spec = w.swap(0, MAX, false)?;
    w.create(&spec)?;
    w.require(false)??;
    let uncounted = w.swap(1, MAX, false)?;
    w.create(&uncounted)?;
    assert_eq!((w.capped(0)?, w.capped(1)?), (MAX, 0));
    assert_eq!(w.outstanding()?, MAX);
    w.fill(1)?;
    assert_eq!(w.outstanding()?, MAX);
    w.fill(0)?;
    assert_eq!(w.outstanding()?, 0);
    Ok(())
}

#[derive(Debug, Clone, Copy)]
enum Op {
    Create { amount: u64, partnered: bool },
    Cancel(usize),
    Expire(usize),
    Close(usize),
    Fill(usize),
    Flash(usize),
    Wait,
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        3 => (1..=MAX, any::<bool>()).prop_map(|(amount, partnered)| Op::Create { amount, partnered }),
        1 => (0..16usize).prop_map(Op::Cancel),
        1 => (0..16usize).prop_map(Op::Expire),
        1 => (0..16usize).prop_map(Op::Close),
        1 => (0..16usize).prop_map(Op::Fill),
        1 => (0..16usize).prop_map(Op::Flash),
        1 => Just(Op::Wait),
    ]
}

fn open_escrow(w: &World, nonces: u64) -> TestResult<(u64, u64)> {
    let mut held = 0u64;
    let mut capped = 0u64;
    for nonce in 0..nonces {
        if w.open(nonce) {
            held = held.checked_add(w.vault(nonce)?).ok_or("overflow")?;
            capped = capped.checked_add(w.capped(nonce)?).ok_or("overflow")?;
        }
    }
    Ok((held, capped))
}

fn run(total_limit: u64, ops: &[Op]) -> TestResult {
    let mut w = capped_world(total_limit)?;
    let mut nonces = 0u64;
    for op in ops {
        let pick = |i: usize| {
            u64::try_from(i)
                .unwrap_or(0)
                .checked_rem(nonces.max(1))
                .unwrap_or(0)
        };
        match *op {
            Op::Create { amount, partnered } => {
                let spec = w.swap(nonces, amount, partnered)?;
                if w.create(&spec).is_ok() {
                    nonces = nonces.saturating_add(1);
                }
            }
            Op::Cancel(i) => drop(w.cancel(pick(i))),
            Op::Expire(i) => drop(w.expire(pick(i))),
            Op::Close(i) => drop(w.close(pick(i))),
            Op::Fill(i) => drop(w.fill(pick(i))),
            Op::Flash(i) => drop(w.flash(pick(i))),
            Op::Wait => {
                let now = w.env.now();
                w.env.set_now(now.saturating_add(TTL / 2));
            }
        }
        let (held, capped) = open_escrow(&w, nonces)?;
        let outstanding = w.outstanding()?;
        assert_eq!(outstanding, held, "after {op:?}");
        assert_eq!(outstanding, capped, "after {op:?}");
        if total_limit > 0 {
            assert!(outstanding <= total_limit, "after {op:?}");
        }
    }
    let now = w.env.now();
    w.env.set_now(now.saturating_add(TTL));
    for nonce in 0..nonces {
        let _ = w.expire(nonce);
        let _ = w.close(nonce);
        assert!(!w.open(nonce));
    }
    assert_eq!(w.outstanding()?, 0);
    Ok(())
}

#[test]
fn fills_and_releases_of_intents_charged_before_a_cap_was_recreated_leave_the_new_cap_intact(
) -> TestResult {
    let mut w = capped_world(0)?;
    let filled = w.swap(0, 300, false)?;
    w.create(&filled)?;
    let attestor = w.attestor.pubkey();
    let released = w.judged(1, 50, &attestor, false)?;
    w.create(&released)?;
    assert_eq!(w.outstanding()?, 350);

    let cap = w.cap();
    let mut account = w.env.svm.get_account(&cap).ok_or("cap missing")?;
    *account
        .data
        .get_mut(offset_of!(MintCap, version).saturating_add(8))
        .ok_or("short")? = 1;
    w.env.svm.set_account(cap, account)?;
    let fees = w.env.fee_recipient;
    let admin = w.admin();
    w.env
        .send(&admin, &[close_legacy_ix(&cap, &fees, true)], &[])?;
    assert!(!w.env.exists(&cap));
    let now = w.env.now();
    w.env.set_now(now.saturating_add(1));
    w.limit(0)??;
    assert_eq!(w.outstanding()?, 0);
    let fresh = w.swap(2, 100, false)?;
    w.create(&fresh)?;
    assert_eq!(w.outstanding()?, 100);

    w.fill(0)?;
    assert_eq!(
        w.outstanding()?,
        100,
        "a fill of an intent charged against the closed cap leaves the new cap's count"
    );
    w.release(1)??;
    assert_eq!(
        w.outstanding()?,
        100,
        "a release of an intent charged against the closed cap leaves the new cap's count"
    );
    for nonce in [0, 1] {
        if w.open(nonce) {
            assert_eq!(w.capped(nonce)?, 0);
        }
    }
    w.fill(2)?;
    assert_eq!(w.outstanding()?, 0);
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(
        std::env::var("MINT_CAP_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(24)
    ))]

    #[test]
    fn the_outstanding_amount_equals_the_open_escrow_of_the_mint(
        total_limit in prop_oneof![Just(0u64), MAX..=4 * MAX],
        ops in prop::collection::vec(op(), 1..40),
    ) {
        run(total_limit, &ops).map_err(|e| TestCaseError::fail(e.to_string()))?;
    }
}
