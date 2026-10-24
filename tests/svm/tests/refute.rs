use anchor_lang::prelude::Pubkey;
use intent_core::kinds::{attested_result, Kind};
use intent_engine::errors::EngineError;
use intent_engine::events::ReleaseRefuted;
use intent_engine::state::{Refutation, PAUSE_FILL, REFUTATION_VERSION};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    attestation_proof_message, commitment_of, cosign_batch_ix, ed25519_ix, engine_error_at, events,
    intent_pda, load, refutation_pda, refute_ix, split_commit, split_digest, swap_spec, Announce,
    Delivery, Env, IntentSpec, Market, Solver, TestResult, Trader, DELIVERED, DOMAIN, SALT,
};

const FUNDED: u64 = 1_000;
const ESCROW: u64 = 400;
const SPEC: [u8; 32] = [0x8e; 32];

struct World {
    env: Env,
    market: Market,
    trader: Trader,
    judge: Keypair,
    early: Solver,
    late: Solver,
    fee_to: Pubkey,
    intent: Pubkey,
}

fn copy(s: &Solver) -> Solver {
    Solver {
        key: s.key.insecure_clone(),
        output: s.output,
        input: s.input,
    }
}

fn world() -> TestResult<World> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(anchor_spl::token::ID, &[], anchor_spl::token::ID, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let judge = env.funded()?;
    let spec = IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: ESCROW,
            min_result: 1,
            max_result: 1,
            attestor: judge.pubkey().to_bytes(),
            spec_hash: SPEC,
            judge_fee: 0,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ..swap_spec(0, ESCROW)?
    };
    env.create_intent(&trader, &market, &spec)?;
    let early = env.solver(&market, 0)?;
    let late = env.solver(&market, 0)?;
    let fee_to = env.fee_account(&market)?;
    let intent = intent_pda(&trader.key.pubkey(), 0);
    Ok(World {
        env,
        market,
        trader,
        judge,
        early,
        late,
        fee_to,
        intent,
    })
}

impl World {
    fn announce(&mut self, who: &Solver) -> TestResult<Delivery> {
        let key = who.key.insecure_clone();
        self.env.announce_for(&key, &self.intent)
    }

    fn pay(&mut self, to: &Solver, d: &Delivery) -> TestResult {
        self.env.announcement = Some(d.announcement);
        self.env.opening = d.opening;
        let message = attestation_proof_message(
            DOMAIN,
            &self.judge.pubkey(),
            &self.intent,
            &to.input,
            ESCROW,
            1,
            SPEC,
            d,
        );
        let owner = self.trader.key.pubkey();
        let fill = self.env.fill_attested_ix(
            &to.key.pubkey(),
            &owner,
            &self.market,
            0,
            &to.input,
            Some(&self.fee_to),
            1,
        );
        let key = to.key.insecure_clone();
        self.env
            .send(&key, &[ed25519_ix(&self.judge, &message), fill], &[])?;
        Ok(())
    }

    fn refute(
        &mut self,
        by: &Keypair,
        paid: &Delivery,
        earlier: &Delivery,
        salt: [u8; 16],
    ) -> Option<TransactionError> {
        let ix = refute_ix(
            &by.pubkey(),
            &paid.announcement,
            &earlier.announcement,
            salt,
            None,
        );
        let signer = by.insecure_clone();
        self.env.send(&signer, &[ix], &[]).err()
    }
}

#[test]
fn an_earlier_worker_records_on_chain_that_a_later_announcer_was_paid() -> TestResult {
    let mut w = world()?;
    let (early, late) = (copy(&w.early), copy(&w.late));
    let first = w.announce(&early)?;
    let second = w.announce(&late)?;
    w.pay(&late, &second)?;
    let ix = refute_ix(
        &early.key.pubkey(),
        &second.announcement,
        &first.announcement,
        SALT,
        None,
    );
    let meta = w.env.send(&early.key, &[ix], &[])?;
    let stored: Refutation = load(&w.env.svm, &refutation_pda(&first.announcement))?;
    assert_eq!(
        (stored.paid_seq, stored.earlier_seq),
        (second.seq, first.seq)
    );
    assert_eq!(
        (stored.paid_worker, stored.earlier_worker, stored.refuter),
        (late.key.pubkey(), early.key.pubkey(), early.key.pubkey())
    );
    assert_eq!(
        (
            stored.paid_announcement,
            stored.earlier_announcement,
            stored.intent
        ),
        (second.announcement, first.announcement, w.intent)
    );
    assert_eq!(
        (stored.delivered, stored.salt, stored.esk),
        (DELIVERED, SALT, [0x45; 32])
    );
    assert_eq!(
        (stored.attestor, stored.version, stored.split_hash),
        (w.judge.pubkey(), REFUTATION_VERSION, [0; 32])
    );
    assert!(stored.blob_len > 0);
    let emitted = events::<ReleaseRefuted>(&meta);
    assert_eq!(
        emitted
            .first()
            .map(|e| (e.paid_seq, e.earlier_seq, e.refuter, e.delivered)),
        Some((second.seq, first.seq, early.key.pubkey(), DELIVERED))
    );
    Ok(())
}

#[test]
fn only_a_paid_release_with_a_later_payee_can_be_refuted() -> TestResult {
    let mut w = world()?;
    let (early, late) = (copy(&w.early), copy(&w.late));
    let first = w.announce(&early)?;
    let second = w.announce(&late)?;
    assert_eq!(
        w.refute(&early.key, &second, &first, SALT),
        Some(engine_error_at(0, EngineError::RefuteNotPaid))
    );
    w.pay(&early, &first)?;
    assert_eq!(
        w.refute(&late.key, &first, &second, SALT),
        Some(engine_error_at(0, EngineError::RefuteNotEarlier))
    );
    Ok(())
}

#[test]
fn the_paid_wallet_cannot_refute_its_own_release() -> TestResult {
    let mut w = world()?;
    let early = copy(&w.early);
    let first = w.announce(&early)?;
    let second = w.announce(&early)?;
    w.pay(&early, &second)?;
    assert_eq!(
        w.refute(&early.key, &second, &first, SALT),
        Some(engine_error_at(0, EngineError::RefuteSamePayee))
    );
    Ok(())
}

#[test]
fn an_earlier_announcement_of_other_work_does_not_refute() -> TestResult {
    let mut w = world()?;
    let (early, late) = (copy(&w.early), copy(&w.late));
    let blob = w.env.delivery_blob(&w.intent, &w.judge.pubkey())?.0;
    let a = Announce {
        commitment: commitment_of(&w.intent, &early.key.pubkey(), &SALT, &[0x22; 32]),
        ..Announce::new(early.key.pubkey(), w.intent, w.judge.pubkey(), blob)
    };
    w.env.send(&early.key, &[a.ix()], &[])?;
    let other_work = Delivery {
        announcement: a.address(),
        seq: 1,
        opening: intent_engine::Opening::default(),
    };
    let paid = w.announce(&late)?;
    w.pay(&late, &paid)?;
    assert_eq!(
        w.refute(&early.key, &paid, &other_work, SALT),
        Some(engine_error_at(0, EngineError::CommitmentMismatch))
    );
    Ok(())
}

#[test]
fn a_judge_cannot_take_the_refutation_slot_and_a_refutation_is_made_once() -> TestResult {
    let mut w = world()?;
    let (early, late) = (copy(&w.early), copy(&w.late));
    let first = w.announce(&early)?;
    let second = w.announce(&late)?;
    w.pay(&late, &second)?;
    let judge = w.judge.insecure_clone();
    assert_eq!(
        w.refute(&judge, &second, &first, SALT),
        Some(engine_error_at(0, EngineError::RefuteNotAnnouncer))
    );
    assert_eq!(
        w.refute(&early.key, &second, &first, [0; 16]),
        Some(engine_error_at(0, EngineError::CommitmentMismatch))
    );
    assert_eq!(w.refute(&early.key, &second, &first, SALT), None);
    w.env.svm.expire_blockhash();
    assert!(w.refute(&early.key, &second, &first, SALT).is_some());
    Ok(())
}

#[test]
fn a_refutation_goes_through_while_fills_are_paused() -> TestResult {
    let mut w = world()?;
    let (early, late) = (copy(&w.early), copy(&w.late));
    let first = w.announce(&early)?;
    let second = w.announce(&late)?;
    w.pay(&late, &second)?;
    let authority = w.env.authority.insecure_clone();
    let pause = w.env.raise_pause_ix(&authority.pubkey(), PAUSE_FILL);
    w.env.send(&authority, &[pause], &[])?;
    assert_eq!(w.refute(&early.key, &second, &first, SALT), None);
    Ok(())
}

#[test]
fn a_split_recipient_cannot_refute_and_a_split_refutation_needs_the_claim() -> TestResult {
    let mut w = world()?;
    let worker = copy(&w.late);
    let outsider = w.env.funded()?;
    let lead = w.env.funded()?;
    let coauthor = Keypair::new();
    for c in [&lead, &coauthor] {
        w.env
            .create_ata(&c.pubkey(), &w.market.input_mint, w.market.input_program)?;
    }
    let first = w.env.announce_for(&outsider, &w.intent)?;
    let recipient_first = w.env.announce_for(&lead, &w.intent)?;
    let recipients = vec![lead.pubkey(), coauthor.pubkey()];
    let weights = [6000u16, 4000];
    let paid = w.env.announce_for(&lead, &w.intent)?;
    let split_hash = split_commit(&recipients, &weights);
    let digest = split_digest(DOMAIN, &w.intent, ESCROW, 1, SPEC, split_hash, &paid);
    let signers: Vec<&Keypair> = vec![&lead, &coauthor, &w.judge];
    let owner = w.trader.key.pubkey();
    w.env.announcement = Some(paid.announcement);
    w.env.opening = paid.opening;
    let split = w.env.fill_attested_split_ix(
        &worker.key.pubkey(),
        &owner,
        &w.market,
        0,
        &recipients,
        &weights,
        Some(&w.fee_to),
        1,
    );
    w.env.send(
        &worker.key,
        &[cosign_batch_ix(&signers, &digest)?, split],
        &[],
    )?;
    let claim = intent_engine::SplitClaim {
        recipients: recipients.clone(),
        weights: weights.to_vec(),
    };
    let bare = refute_ix(
        &outsider.pubkey(),
        &paid.announcement,
        &first.announcement,
        SALT,
        None,
    );
    assert_eq!(
        w.env.send(&outsider, &[bare], &[]).err(),
        Some(engine_error_at(0, EngineError::RefuteSplitMismatch))
    );
    let skewed = intent_engine::SplitClaim {
        recipients: recipients.clone(),
        weights: vec![5000, 5000],
    };
    let wrong = refute_ix(
        &outsider.pubkey(),
        &paid.announcement,
        &first.announcement,
        SALT,
        Some(skewed),
    );
    assert_eq!(
        w.env.send(&outsider, &[wrong], &[]).err(),
        Some(engine_error_at(0, EngineError::RefuteSplitMismatch))
    );
    let own = refute_ix(
        &lead.pubkey(),
        &paid.announcement,
        &recipient_first.announcement,
        SALT,
        Some(claim.clone()),
    );
    assert_eq!(
        w.env.send(&lead, &[own], &[]).err(),
        Some(engine_error_at(0, EngineError::RefuteSamePayee))
    );
    let outside = refute_ix(
        &outsider.pubkey(),
        &paid.announcement,
        &first.announcement,
        SALT,
        Some(claim),
    );
    w.env.send(&outsider, &[outside], &[])?;
    let stored: Refutation = load(&w.env.svm, &refutation_pda(&first.announcement))?;
    assert_eq!(stored.split_hash, split_hash);
    Ok(())
}
