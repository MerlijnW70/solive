use anchor_lang::prelude::Pubkey;
use intent_core::kinds::{attested_result, Kind};
use intent_engine::errors::EngineError;
use intent_engine::events::DeliveryReleased;
use intent_engine::state::Announcement;
use intent_engine::Opening;
use litesvm::types::TransactionMetadata;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    attestation_message, attestation_proof_message, cosign_batch_ix, ed25519_ix, engine_error_at,
    events, intent_pda, load, split_commit, split_digest, swap_spec, Delivery, Env, IntentSpec,
    Market, Solver, TestResult, Trader, DELIVERED, DOMAIN, SALT,
};

const FUNDED: u64 = 4_000;
const ESCROW: u64 = 400;
const SPEC: [u8; 32] = [0x6d; 32];

struct World {
    env: Env,
    market: Market,
    trader: Trader,
    judge: Keypair,
    worker: Solver,
    other: Solver,
    fee_to: Pubkey,
}

fn spec(nonce: u64, attestor: &Pubkey, spec_hash: [u8; 32]) -> TestResult<IntentSpec> {
    Ok(IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: ESCROW,
            min_result: 1,
            max_result: 1,
            attestor: attestor.to_bytes(),
            spec_hash,
            judge_fee: 0,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ..swap_spec(nonce, ESCROW)?
    })
}

fn world() -> TestResult<World> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(anchor_spl::token::ID, &[], anchor_spl::token::ID, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let judge = env.funded()?;
    env.create_intent(&trader, &market, &spec(0, &judge.pubkey(), SPEC)?)?;
    env.create_intent(&trader, &market, &spec(1, &judge.pubkey(), [0; 32])?)?;
    env.create_intent(&trader, &market, &spec(2, &judge.pubkey(), SPEC)?)?;
    let worker = env.solver(&market, 0)?;
    let other = env.solver(&market, 0)?;
    let fee_to = env.fee_account(&market)?;
    Ok(World {
        env,
        market,
        trader,
        judge,
        worker,
        other,
        fee_to,
    })
}

impl World {
    fn intent(&self, nonce: u64) -> Pubkey {
        intent_pda(&self.trader.key.pubkey(), nonce)
    }

    fn release_to(
        &mut self,
        payee: &Solver,
        signed: &Delivery,
        fee_payer: &Keypair,
    ) -> Result<TransactionMetadata, TransactionError> {
        let intent = self.intent(0);
        let message = attestation_proof_message(
            DOMAIN,
            &self.judge.pubkey(),
            &intent,
            &payee.input,
            ESCROW,
            1,
            SPEC,
            signed,
        );
        let owner = self.trader.key.pubkey();
        let fill = self.env.fill_attested_ix(
            &fee_payer.pubkey(),
            &owner,
            &self.market,
            0,
            &payee.input,
            Some(&self.fee_to),
            1,
        );
        let payer = fee_payer.insecure_clone();
        self.env
            .send(&payer, &[ed25519_ix(&self.judge, &message), fill], &[])
    }

    fn release(
        &mut self,
        payee: &Solver,
        signed: &Delivery,
    ) -> Result<TransactionMetadata, TransactionError> {
        let key = payee.key.insecure_clone();
        self.release_to(payee, signed, &key)
    }
}

fn worker_of(w: &World) -> (Solver, Keypair) {
    let s = Solver {
        key: w.worker.key.insecure_clone(),
        output: w.worker.output,
        input: w.worker.input,
    };
    let k = w.worker.key.insecure_clone();
    (s, k)
}

#[test]
fn a_release_pays_the_announcing_worker_and_marks_the_announcement_paid() -> TestResult {
    let mut w = world()?;
    let (worker, key) = worker_of(&w);
    let intent = w.intent(0);
    let delivery = w.env.announce_for(&key, &intent)?;
    let before = w.env.balance(&worker.input)?;
    let meta = w.release(&worker, &delivery)?;
    assert!(w.env.balance(&worker.input)? > before);
    let paid: Announcement = load(&w.env.svm, &delivery.announcement)?;
    assert_eq!(
        (paid.state, paid.delivered, paid.salt, paid.split_hash),
        (1, DELIVERED, SALT, [0; 32])
    );
    assert_eq!(paid.paid_at, w.env.now());
    let emitted = events::<DeliveryReleased>(&meta);
    assert_eq!(emitted.len(), 1);
    assert_eq!(
        emitted.first().map(|e| (
            e.intent,
            e.announcement,
            e.seq,
            e.worker,
            e.attestor,
            e.delivered,
            e.salt
        )),
        Some((
            intent,
            delivery.announcement,
            delivery.seq,
            worker.key.pubkey(),
            w.judge.pubkey(),
            DELIVERED,
            SALT
        ))
    );
    Ok(())
}

#[test]
fn a_proof_release_names_an_announcement_or_is_refused() -> TestResult {
    let mut w = world()?;
    let (worker, key) = worker_of(&w);
    let intent = w.intent(0);
    let delivery = w.env.announce_for(&key, &intent)?;
    w.env.announcement = None;
    assert_eq!(
        w.release(&worker, &delivery).err(),
        Some(engine_error_at(1, EngineError::AnnouncementMissing))
    );
    Ok(())
}

#[test]
fn a_release_pays_only_the_wallet_that_announced() -> TestResult {
    let mut w = world()?;
    let (_, key) = worker_of(&w);
    let intent = w.intent(0);
    let delivery = w.env.announce_for(&key, &intent)?;
    let other = Solver {
        key: w.other.key.insecure_clone(),
        output: w.other.output,
        input: w.other.input,
    };
    assert_eq!(
        w.release(&other, &delivery).err(),
        Some(engine_error_at(1, EngineError::PayeeNotAnnouncer))
    );
    Ok(())
}

#[test]
fn the_opening_must_open_the_announced_commitment() -> TestResult {
    let mut w = world()?;
    let (worker, key) = worker_of(&w);
    let intent = w.intent(0);
    let delivery = w.env.announce_for(&key, &intent)?;
    for opening in [
        Opening {
            delivered: DELIVERED,
            salt: [0; 16],
        },
        Opening {
            delivered: [0; 32],
            salt: SALT,
        },
    ] {
        w.env.opening = opening;
        assert_eq!(
            w.release(
                &worker,
                &Delivery {
                    opening,
                    ..delivery
                }
            )
            .err(),
            Some(engine_error_at(1, EngineError::CommitmentMismatch))
        );
    }
    Ok(())
}

#[test]
fn an_announcement_of_another_escrow_is_refused() -> TestResult {
    let mut w = world()?;
    let (worker, key) = worker_of(&w);
    let elsewhere = w.intent(2);
    let delivery = w.env.announce_for(&key, &elsewhere)?;
    assert_eq!(
        w.release(&worker, &delivery).err(),
        Some(engine_error_at(1, EngineError::AnnouncementMismatch))
    );
    Ok(())
}

#[test]
fn a_judge_signature_names_one_announcement() -> TestResult {
    let mut w = world()?;
    let (worker, key) = worker_of(&w);
    let intent = w.intent(0);
    let first = w.env.announce_for(&key, &intent)?;
    let second = w.env.announce_for(&key, &intent)?;
    assert_eq!((first.seq, second.seq), (1, 2));
    assert_eq!(
        w.release(&worker, &first).err(),
        Some(engine_error_at(1, EngineError::SigMessage))
    );
    w.release(&worker, &second)?;
    Ok(())
}

#[test]
fn anyone_can_relay_the_judges_release_and_the_worker_is_paid() -> TestResult {
    let mut w = world()?;
    let (worker, key) = worker_of(&w);
    let intent = w.intent(0);
    let delivery = w.env.announce_for(&key, &intent)?;
    let relayer = w.env.funded()?;
    let before = w.env.balance(&worker.input)?;
    w.release_to(&worker, &delivery, &relayer)?;
    assert!(w.env.balance(&worker.input)? > before);
    Ok(())
}

#[test]
fn a_plain_attested_escrow_takes_no_announcement() -> TestResult {
    let mut w = world()?;
    let (worker, key) = worker_of(&w);
    let proof = w.intent(0);
    let announced = w.env.announce_for(&key, &proof)?;
    let plain = w.intent(1);
    let owner = w.trader.key.pubkey();
    let message = attestation_message(DOMAIN, &w.judge.pubkey(), &plain, &worker.input, ESCROW, 1);
    let send = |w: &mut World| {
        let fill = w.env.fill_attested_ix(
            &key.pubkey(),
            &owner,
            &w.market,
            1,
            &worker.input,
            Some(&w.fee_to),
            1,
        );
        w.env
            .send(&key, &[ed25519_ix(&w.judge, &message), fill], &[])
    };
    w.env.announcement = Some(announced.announcement);
    w.env.opening = Opening::default();
    assert_eq!(
        send(&mut w).err(),
        Some(engine_error_at(1, EngineError::AnnouncementUnexpected))
    );
    w.env.announcement = None;
    w.env.opening = announced.opening;
    assert_eq!(
        send(&mut w).err(),
        Some(engine_error_at(1, EngineError::AnnouncementUnexpected))
    );
    w.env.opening = Opening::default();
    send(&mut w)?;
    Ok(())
}

#[test]
fn a_split_pays_only_with_a_recipients_announcement_and_records_the_split() -> TestResult {
    let mut w = world()?;
    let coauthors = [Keypair::new(), Keypair::new()];
    for c in &coauthors {
        w.env
            .svm
            .airdrop(&c.pubkey(), 1_000_000_000)
            .map_err(|f| format!("{:?}", f.err))?;
        w.env
            .create_ata(&c.pubkey(), &w.market.input_mint, w.market.input_program)?;
    }
    let recipients: Vec<Pubkey> = coauthors.iter().map(Signer::pubkey).collect();
    let weights = [6000u16, 4000];
    let intent = w.intent(0);
    let split_hash = split_commit(&recipients, &weights);
    let outsider = w.other.key.insecure_clone();
    let stranger = w.env.announce_for(&outsider, &intent)?;
    let first = coauthors.first().ok_or("coauthor")?.insecure_clone();
    let owner = w.trader.key.pubkey();
    let signers: Vec<&Keypair> = coauthors.iter().chain(std::iter::once(&w.judge)).collect();
    let solver = w.worker.key.insecure_clone();
    let digest = split_digest(DOMAIN, &intent, ESCROW, 1, SPEC, split_hash, &stranger);
    let split = w.env.fill_attested_split_ix(
        &solver.pubkey(),
        &owner,
        &w.market,
        0,
        &recipients,
        &weights,
        Some(&w.fee_to),
        1,
    );
    assert_eq!(
        w.env
            .send(&solver, &[cosign_batch_ix(&signers, &digest)?, split], &[])
            .err(),
        Some(engine_error_at(1, EngineError::AnnouncerNotRecipient))
    );
    let delivery = w.env.announce_for(&first, &intent)?;
    let digest = split_digest(DOMAIN, &intent, ESCROW, 1, SPEC, split_hash, &delivery);
    let split = w.env.fill_attested_split_ix(
        &solver.pubkey(),
        &owner,
        &w.market,
        0,
        &recipients,
        &weights,
        Some(&w.fee_to),
        1,
    );
    let meta = w
        .env
        .send(&solver, &[cosign_batch_ix(&signers, &digest)?, split], &[])?;
    let paid: Announcement = load(&w.env.svm, &delivery.announcement)?;
    assert_eq!((paid.state, paid.split_hash), (1, split_hash));
    assert_eq!(
        events::<DeliveryReleased>(&meta)
            .first()
            .map(|e| (e.worker, e.split_hash)),
        Some((first.pubkey(), split_hash))
    );
    Ok(())
}
