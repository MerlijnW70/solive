use anchor_lang::prelude::Pubkey;
use intent_core::bounty::split_n;
use intent_core::committee::COMMITTEE_COSIGN_TAG;
use intent_core::kinds::{attested_result, Kind};
use intent_core::sig::{offchain_envelope, SPLIT_COSIGN_TAG};
use intent_engine::errors::EngineError;
use intent_engine::events::{CommitteeAttested, CommitteeCreated, IntentAttested};
use intent_engine::state::{Committee, COMMITTEE_SEED, COMMITTEE_VERSION};
use litesvm::types::TransactionMetadata;
use solana_instruction::Instruction;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    batch_ix, committee_batch_ix, committee_id, committee_message, committee_pda,
    cosign_in_message, cosign_ix, create_committee_ix, create_committee_with_id_ix, ed25519_ix,
    engine_error_at, events, intent_pda, load, proof_digest, proof_preimage, raw_cosign_message,
    sorted_members, split_commit, split_digest, swap_spec, vault_pda, CommitteeFill, Delivery, Env,
    IntentSpec, Market, Solver, TestResult, Trader, DOMAIN,
};

const FUNDED: u64 = 1_000;
const ESCROW: u64 = 400;
const SPEC: [u8; 32] = [0x7c; 32];

struct Panel {
    members: Vec<Keypair>,
    keys: Vec<Pubkey>,
    fee_wallet: Pubkey,
    address: Pubkey,
}

impl Panel {
    fn signers(&self, picks: &[usize]) -> Vec<&Keypair> {
        picks.iter().filter_map(|i| self.members.get(*i)).collect()
    }

    fn batch(&self, picks: &[usize], digest: &[u8; 32]) -> TestResult<Instruction> {
        committee_batch_ix(&self.keys, &self.signers(picks), digest)
    }
}

struct World {
    env: Env,
    market: Market,
    trader: Trader,
    panel: Panel,
    solver: Solver,
    fee_to: Pubkey,
    delivery: Delivery,
}

fn convene(env: &mut Env, size: usize, threshold: u8) -> TestResult<Panel> {
    let members = sorted_members(size);
    let keys: Vec<Pubkey> = members.iter().map(Signer::pubkey).collect();
    let fee_wallet = Pubkey::new_unique();
    let payer = env.funded()?;
    let (ix, address) = create_committee_ix(&payer.pubkey(), &keys, threshold, &fee_wallet)?;
    env.send(&payer, &[ix], &[])?;
    Ok(Panel {
        members,
        keys,
        fee_wallet,
        address,
    })
}

fn escrow_spec(attestor: &Pubkey, judge_fee: u64) -> TestResult<IntentSpec> {
    Ok(IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: ESCROW,
            min_result: 1,
            max_result: 1,
            attestor: attestor.to_bytes(),
            spec_hash: SPEC,
            judge_fee,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ..swap_spec(0, ESCROW)?
    })
}

fn world(size: usize, threshold: u8, judge_fee: u64) -> TestResult<World> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(anchor_spl::token::ID, &[], anchor_spl::token::ID, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let panel = convene(&mut env, size, threshold)?;
    env.create_intent(&trader, &market, &escrow_spec(&panel.address, judge_fee)?)?;
    let solver = env.solver(&market, 0)?;
    let fee_to = env.fee_account(&market)?;
    let delivery = env.announce_for(&solver.key, &intent_pda(&trader.key.pubkey(), 0))?;
    Ok(World {
        env,
        market,
        trader,
        panel,
        solver,
        fee_to,
        delivery,
    })
}

impl World {
    fn owner(&self) -> Pubkey {
        self.trader.key.pubkey()
    }

    fn intent(&self) -> Pubkey {
        intent_pda(&self.owner(), 0)
    }

    fn digest(&self, payee: &Pubkey) -> [u8; 32] {
        proof_digest(
            DOMAIN,
            &self.intent(),
            payee,
            ESCROW,
            1,
            SPEC,
            &self.delivery,
        )
    }

    fn tagged(&self, tag: &[u8], payee: &Pubkey) -> [u8; 32] {
        let preimage = proof_preimage(
            DOMAIN,
            &self.intent(),
            payee,
            ESCROW,
            1,
            SPEC,
            &self.delivery,
        );
        solana_sha256_hasher::hashv(&[tag, &preimage]).to_bytes()
    }

    fn payee(&self) -> Pubkey {
        self.solver.input
    }

    fn fill(&self, committee: &Pubkey, mask: u8) -> Instruction {
        let owner = self.owner();
        self.env.fill_attested_committee_ix(
            &CommitteeFill {
                solver: &self.solver.key.pubkey(),
                owner: &owner,
                market: &self.market,
                nonce: 0,
                fee_to: Some(&self.fee_to),
                committee,
                signers: mask,
                result: 1,
            },
            &self.solver.input,
        )
    }

    fn release(
        &mut self,
        batch: Instruction,
        committee: &Pubkey,
        mask: u8,
    ) -> Result<TransactionMetadata, TransactionError> {
        let fill = self.fill(committee, mask);
        self.env.send(&self.solver.key, &[batch, fill], &[])
    }
}

#[test]
fn a_committee_lives_at_the_hash_of_its_members_threshold_and_fee_wallet() -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let members = sorted_members(3);
    let keys: Vec<Pubkey> = members.iter().map(Signer::pubkey).collect();
    let fee_wallet = Pubkey::new_unique();
    let payer = env.funded()?;
    let id = committee_id(&keys, 2, &fee_wallet)?;
    let (ix, address) = create_committee_ix(&payer.pubkey(), &keys, 2, &fee_wallet)?;
    assert_eq!(address, committee_pda(&id));
    let meta = env.send(&payer, &[ix], &[])?;
    let stored: Committee = load(&env.svm, &address)?;
    assert_eq!(stored.members.get(..3), Some(&keys[..]));
    assert!(stored
        .members
        .get(3..)
        .is_some_and(|rest| rest.iter().all(|k| *k == Pubkey::default())));
    assert_eq!(
        (stored.threshold, stored.count, stored.fee_wallet, stored.id),
        (2, 3, fee_wallet, id)
    );
    let (_, bump) = Pubkey::find_program_address(&[COMMITTEE_SEED, &id], &intent_engine::ID);
    assert_eq!(
        (stored.created_at, stored.bump, stored.version),
        (env.now(), bump, COMMITTEE_VERSION)
    );
    let created: Vec<_> = events::<CommitteeCreated>(&meta)
        .into_iter()
        .map(|e| (e.committee, e.members, e.threshold, e.fee_wallet))
        .collect();
    assert_eq!(created, [(address, keys.clone(), 2, fee_wallet)]);
    let (again, _) = create_committee_ix(&payer.pubkey(), &keys, 2, &fee_wallet)?;
    assert!(
        env.send(&payer, &[again], &[]).is_err(),
        "the same committee cannot be created twice"
    );
    Ok(())
}

#[test]
fn a_committee_whose_address_does_not_match_its_contents_is_refused() -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let members = sorted_members(3);
    let keys: Vec<Pubkey> = members.iter().map(Signer::pubkey).collect();
    let fee_wallet = Pubkey::new_unique();
    let payer = env.funded()?;
    let other = committee_id(&keys, 3, &fee_wallet)?;
    let lying = create_committee_with_id_ix(&payer.pubkey(), other, &keys, 2, &fee_wallet);
    assert_eq!(
        env.send(&payer, &[lying], &[]).err(),
        Some(engine_error_at(0, EngineError::CommitteeInvalid)),
        "an id that is not the hash of the contents is refused"
    );
    let mut unsorted = keys.clone();
    unsorted.reverse();
    let mut duplicated = keys.clone();
    if let (Some(first), Some(second)) = (keys.first(), duplicated.get_mut(1)) {
        *second = *first;
    }
    for (members, threshold, wallet) in [
        (unsorted, 2, fee_wallet),
        (duplicated, 2, fee_wallet),
        (keys.clone(), 0, fee_wallet),
        (keys.clone(), 4, fee_wallet),
        (keys.clone(), 2, Pubkey::default()),
        (Vec::new(), 1, fee_wallet),
    ] {
        let id = solana_sha256_hasher::hashv(&[&[threshold]]).to_bytes();
        let ix = create_committee_with_id_ix(&payer.pubkey(), id, &members, threshold, &wallet);
        assert_eq!(
            env.send(&payer, &[ix], &[]).err(),
            Some(engine_error_at(0, EngineError::CommitteeInvalid)),
            "{members:?} {threshold}"
        );
    }
    Ok(())
}

#[test]
fn a_quorum_of_members_releases_the_escrow_and_is_named_in_the_event() -> TestResult {
    let mut w = world(3, 2, 0)?;
    let payee = w.payee();
    let digest = w.digest(&payee);
    let batch = w.panel.batch(&[0, 2], &digest)?;
    let committee = w.panel.address;
    let meta = w.release(batch, &committee, 0b101)?;
    assert_eq!(w.env.balance(&payee)?, ESCROW - 1);
    assert_eq!(w.env.balance(&vault_pda(&w.intent()))?, 0);
    let attested: Vec<_> = events::<IntentAttested>(&meta)
        .into_iter()
        .map(|e| (e.attestor, e.payee))
        .collect();
    assert_eq!(attested, [(committee, payee)]);
    let signed: Vec<_> = events::<CommitteeAttested>(&meta)
        .into_iter()
        .map(|e| (e.intent, e.committee, e.signers))
        .collect();
    let named = [w.panel.keys.first(), w.panel.keys.get(2)]
        .into_iter()
        .flatten()
        .copied()
        .collect::<Vec<_>>();
    assert_eq!(signed, [(w.intent(), committee, named)]);
    Ok(())
}

#[test]
fn fewer_members_than_the_threshold_or_bits_beyond_the_committee_are_refused() -> TestResult {
    let mut w = world(3, 2, 0)?;
    let payee = w.payee();
    let digest = w.digest(&payee);
    let committee = w.panel.address;
    let lone = w.panel.batch(&[1], &digest)?;
    assert_eq!(
        w.release(lone, &committee, 0b010).err(),
        Some(engine_error_at(1, EngineError::CommitteeSigners)),
        "one signature is below a threshold of two"
    );
    let beyond = w.panel.batch(&[0, 1], &digest)?;
    assert_eq!(
        w.release(beyond, &committee, 0b1011).err(),
        Some(engine_error_at(1, EngineError::CommitteeSigners)),
        "a bit past the last member is refused"
    );
    assert_eq!(w.env.balance(&vault_pda(&w.intent()))?, ESCROW);
    Ok(())
}

#[test]
fn the_batch_must_be_exactly_the_masked_members_in_order_over_the_committee_message() -> TestResult
{
    let mut w = world(3, 2, 0)?;
    let payee = w.payee();
    let digest = w.digest(&payee);
    let committee = w.panel.address;
    let stranger = Keypair::new();
    let keys = w.panel.keys.clone();
    let mut with_stranger = keys.clone();
    with_stranger.push(stranger.pubkey());
    let split_tagged = w.tagged(&SPLIT_COSIGN_TAG, &payee);
    let untagged = w.tagged(&[], &payee);
    let elsewhere = w.digest(&Pubkey::new_unique());
    let members = std::mem::take(&mut w.panel.members);
    let [a, b, c] = [0, 1, 2].map(|i| members.get(i));
    let (Some(a), Some(b), Some(c)) = (a, b, c) else {
        return Err("panel too small".into());
    };
    let cases: Vec<(Instruction, u8, EngineError, &str)> = vec![
        (
            committee_batch_ix(&with_stranger, &[a, &stranger], &digest)?,
            0b011,
            EngineError::SigHeader,
            "a stranger signing for a member",
        ),
        (
            cosign_in_message(&[b, a], &committee_message(&keys, &digest)?)?,
            0b011,
            EngineError::SigHeader,
            "members out of order",
        ),
        (
            committee_batch_ix(&keys, &[a, b, c], &digest)?,
            0b011,
            EngineError::SigHeader,
            "a signature the mask did not name",
        ),
        (
            committee_batch_ix(&keys, &[a], &digest)?,
            0b011,
            EngineError::SigHeader,
            "a masked member who did not sign",
        ),
        (
            committee_batch_ix(&keys, &[a, b], &split_tagged)?,
            0b011,
            EngineError::SigMessage,
            "a digest under the split tag",
        ),
        (
            committee_batch_ix(&keys, &[a, b], &untagged)?,
            0b011,
            EngineError::SigMessage,
            "a digest without the committee tag",
        ),
        (
            batch_ix(
                &[a, b],
                &offchain_envelope(&COMMITTEE_COSIGN_TAG, &untagged),
            )?,
            0b011,
            EngineError::SigHeader,
            "the old envelope with the tag in its signer field",
        ),
        (
            committee_batch_ix(&keys, &[a, b], &elsewhere)?,
            0b011,
            EngineError::SigMessage,
            "a release to another payee",
        ),
    ];
    for (batch, mask, error, why) in cases {
        assert_eq!(
            w.release(batch, &committee, mask).err(),
            Some(engine_error_at(1, error)),
            "{why}"
        );
    }
    assert_eq!(w.env.balance(&vault_pda(&w.intent()))?, ESCROW);
    let honest = committee_batch_ix(&keys, &[b, a], &digest)?;
    w.release(honest, &committee, 0b011)?;
    assert_eq!(w.env.balance(&payee)?, ESCROW - 1);
    Ok(())
}

#[test]
fn the_envelope_must_list_every_member_sorted_once() -> TestResult {
    let mut w = world(4, 2, 0)?;
    let payee = w.payee();
    let digest = w.digest(&payee);
    let committee = w.panel.address;
    let keys = w.panel.keys.clone();
    let [ka, kb, kc, kd] = [0, 1, 2, 3].map(|i| keys.get(i).copied().unwrap_or_default());
    let stranger = Pubkey::new_unique();
    let cases: [(Vec<Pubkey>, EngineError, &str); 6] = [
        (vec![ka, kb, kc], EngineError::SigHeader, "a missing member"),
        (
            vec![ka, kb, kc, kd, stranger],
            EngineError::SigHeader,
            "an extra key",
        ),
        (
            vec![ka, kb, kd, kc],
            EngineError::SigMessage,
            "unsorted members",
        ),
        (
            vec![ka, kb, kc, kc],
            EngineError::SigMessage,
            "a duplicated member",
        ),
        (
            vec![ka, kb, kc, stranger],
            EngineError::SigMessage,
            "a stranger in a member's place",
        ),
        (
            vec![ka, kb, kb, kc, kd],
            EngineError::SigHeader,
            "a duplicated key on top of every member",
        ),
    ];
    for (listed, error, why) in cases {
        let message = raw_cosign_message(&listed, &digest)?;
        let batch = cosign_in_message(&w.panel.signers(&[0, 1]), &message)?;
        assert_eq!(
            w.release(batch, &committee, 0b0011).err(),
            Some(engine_error_at(1, error)),
            "{why}"
        );
    }
    let message = raw_cosign_message(&keys, &digest)?;
    let batch = cosign_in_message(&w.panel.signers(&[0, 1]), &message)?;
    w.release(batch, &committee, 0b0011)?;
    assert_eq!(w.env.balance(&payee)?, ESCROW - 1);
    Ok(())
}

#[test]
fn only_the_committee_the_escrow_names_can_release_it() -> TestResult {
    let mut w = world(3, 2, 0)?;
    let payee = w.payee();
    let digest = w.digest(&payee);
    let rival = convene(&mut w.env, 3, 2)?;
    let batch = rival.batch(&[0, 1], &digest)?;
    assert_eq!(
        w.release(batch, &rival.address, 0b011).err(),
        Some(engine_error_at(1, EngineError::CommitteeMismatch)),
        "a valid quorum of another committee is refused"
    );
    let member = w.panel.members.first().ok_or("panel empty")?;
    let message = offchain_envelope(&member.pubkey().to_bytes(), &digest);
    let owner = w.owner();
    let fill = w.env.fill_attested_ix(
        &w.solver.key.pubkey(),
        &owner,
        &w.market,
        0,
        &payee,
        Some(&w.fee_to),
        1,
    );
    assert_eq!(
        w.env
            .send(&w.solver.key, &[ed25519_ix(member, &message), fill], &[])
            .err(),
        Some(engine_error_at(1, EngineError::SigPubkey)),
        "a single member cannot release a committee escrow through the single-key path"
    );
    assert_eq!(w.env.balance(&vault_pda(&w.intent()))?, ESCROW);
    Ok(())
}

#[test]
fn a_committee_cannot_release_an_escrow_judged_by_a_single_key() -> TestResult {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(anchor_spl::token::ID, &[], anchor_spl::token::ID, &[])?;
    let trader = env.trader(&market, FUNDED)?;
    let panel = convene(&mut env, 2, 1)?;
    let judge = Keypair::new();
    env.create_intent(&trader, &market, &escrow_spec(&judge.pubkey(), 0)?)?;
    let owner = trader.key.pubkey();
    let solver = env.solver(&market, 0)?;
    let fee_to = env.fee_account(&market)?;
    let delivery = env.announce_for(&solver.key, &intent_pda(&owner, 0))?;
    let digest = proof_digest(
        DOMAIN,
        &intent_pda(&owner, 0),
        &solver.input,
        ESCROW,
        1,
        SPEC,
        &delivery,
    );
    let fill = env.fill_attested_committee_ix(
        &CommitteeFill {
            solver: &solver.key.pubkey(),
            owner: &owner,
            market: &market,
            nonce: 0,
            fee_to: Some(&fee_to),
            committee: &panel.address,
            signers: 0b01,
            result: 1,
        },
        &solver.input,
    );
    let batch = panel.batch(&[0], &digest)?;
    assert_eq!(
        env.send(&solver.key, &[batch, fill], &[]).err(),
        Some(engine_error_at(1, EngineError::CommitteeMismatch))
    );
    Ok(())
}

#[test]
fn the_judge_fee_goes_to_the_committee_fee_wallet_and_nowhere_else() -> TestResult {
    const JF: u64 = 40;
    let mut w = world(3, 2, JF)?;
    let payee = w.payee();
    let digest = w.digest(&payee);
    let committee = w.panel.address;
    let member = w.panel.keys.first().copied().ok_or("panel empty")?;
    let member_ata = w
        .env
        .create_ata(&member, &w.market.input_mint, w.market.input_program)?;
    w.env.judge_to = Some(member_ata);
    let batch = w.panel.batch(&[0, 1], &digest)?;
    assert_eq!(
        w.release(batch, &committee, 0b011).err(),
        Some(engine_error_at(1, EngineError::FeeAccountNotCanonical)),
        "a member cannot take the committee's fee"
    );
    let fee_wallet = w.panel.fee_wallet;
    let wallet_ata = w
        .env
        .create_ata(&fee_wallet, &w.market.input_mint, w.market.input_program)?;
    w.env.judge_to = Some(wallet_ata);
    let batch = w.panel.batch(&[0, 1], &digest)?;
    let fee_before = w.env.balance(&w.fee_to)?;
    w.release(batch, &committee, 0b011)?;
    let protocol = w.env.balance(&w.fee_to)? - fee_before;
    assert_eq!(w.env.balance(&wallet_ata)?, JF);
    assert_eq!(w.env.balance(&payee)? + protocol, ESCROW - JF);
    assert_eq!(w.env.balance(&vault_pda(&w.intent()))?, 0);
    Ok(())
}

#[test]
fn a_team_split_is_released_by_its_co_authors_and_a_committee_quorum() -> TestResult {
    let mut w = world(3, 2, 0)?;
    let owner = w.owner();
    let intent = w.intent();
    let coauthors = [Keypair::new(), Keypair::new()];
    let recipients: Vec<Pubkey> = coauthors.iter().map(Signer::pubkey).collect();
    let weights = [6000u16, 4000];
    let mut atas = Vec::new();
    for r in &recipients {
        atas.push(
            w.env
                .create_ata(r, &w.market.input_mint, w.market.input_program)?,
        );
    }
    let solver = &w.solver;
    let fee_to = w.fee_to;
    let fee_before = w.env.balance(&fee_to)?;
    let delivery = w
        .env
        .announce_as(coauthors.first().ok_or("coauthor")?, &intent)?;
    let digest = split_digest(
        DOMAIN,
        &intent,
        ESCROW,
        1,
        SPEC,
        split_commit(&recipients, &weights),
        &delivery,
    );
    let fill = |env: &Env, committee: &Pubkey, mask: u8| {
        env.fill_attested_split_committee_ix(
            &CommitteeFill {
                solver: &solver.key.pubkey(),
                owner: &owner,
                market: &w.market,
                nonce: 0,
                fee_to: Some(&fee_to),
                committee,
                signers: mask,
                result: 1,
            },
            &recipients,
            &weights,
        )
    };
    let committee = w.panel.address;
    let [a, b] = &coauthors;
    let listed: Vec<Pubkey> = recipients
        .iter()
        .chain(w.panel.keys.iter())
        .copied()
        .collect();
    let short: Vec<&Keypair> = [a, b].into_iter().chain(w.panel.signers(&[0])).collect();
    let ixs = vec![
        cosign_ix(&listed, &short, &digest)?,
        fill(&w.env, &committee, 0b011),
    ];
    assert_eq!(
        w.env.send(&solver.key, &ixs, &[]).err(),
        Some(engine_error_at(1, EngineError::SigHeader)),
        "a quorum member missing from the cosign batch is refused"
    );
    let signers: Vec<&Keypair> = [a, b].into_iter().chain(w.panel.signers(&[0, 1])).collect();
    let only_signers: Vec<Pubkey> = signers.iter().map(|s| s.pubkey()).collect();
    let ixs = vec![
        cosign_ix(&only_signers, &signers, &digest)?,
        fill(&w.env, &committee, 0b011),
    ];
    assert_eq!(
        w.env.send(&solver.key, &ixs, &[]).err(),
        Some(engine_error_at(1, EngineError::SigHeader)),
        "the envelope lists every member, not only the quorum"
    );
    let ixs = vec![
        cosign_ix(&listed, &signers, &digest)?,
        fill(&w.env, &committee, 0b011),
    ];
    let meta = w.env.send(&solver.key, &ixs, &[])?;
    let mut paid = Vec::new();
    for ata in &atas {
        paid.push(w.env.balance(ata)?);
    }
    let net: u64 = paid.iter().sum();
    let plan = split_n(net, &weights).map_err(|e| format!("{e:?}"))?;
    assert_eq!(paid.as_slice(), plan.as_slice());
    assert_eq!(net + (w.env.balance(&fee_to)? - fee_before), ESCROW);
    assert_eq!(w.env.balance(&vault_pda(&intent))?, 0);
    let signed: Vec<_> = events::<CommitteeAttested>(&meta)
        .into_iter()
        .map(|e| e.signers)
        .collect();
    assert_eq!(signed, [w.panel.keys.get(..2).ok_or("panel")?.to_vec()]);
    Ok(())
}
