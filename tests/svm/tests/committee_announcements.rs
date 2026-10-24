use anchor_lang::prelude::Pubkey;
use intent_core::kinds::{attested_result, Kind};
use intent_engine::delivery::fingerprint;
use intent_engine::errors::EngineError;
use intent_engine::events::CommitteeKeysSynced;
use intent_engine::state::Committee;
use solana_keypair::Keypair;
use solana_signer::Signer;
use svm_tests::{
    create_committee_ix, create_profile_ix, engine_error_at, events, intent_pda, load, profile_pda,
    swap_spec, sync_committee_keys_ix, test_blob, update_profile_ix, Announce, Env, IntentSpec,
    TestResult,
};

const KEY0: [u8; 32] = [3; 32];
const KEY2: [u8; 32] = [5; 32];

struct World {
    env: Env,
    members: Vec<Keypair>,
    committee: Pubkey,
    intent: Pubkey,
}

fn world() -> TestResult<World> {
    let mut env = Env::new()?;
    env.init_config()?;
    let market = env.market(anchor_spl::token::ID, &[], anchor_spl::token::ID, &[])?;
    let trader = env.trader(&market, 1_000)?;
    let mut members = vec![env.funded()?, env.funded()?, env.funded()?];
    members.sort_by_key(Signer::pubkey);
    let keys: Vec<Pubkey> = members.iter().map(Signer::pubkey).collect();
    let payer = env.funded()?;
    let fee_wallet = Keypair::new().pubkey();
    let (ix, committee) = create_committee_ix(&payer.pubkey(), &keys, 2, &fee_wallet)?;
    env.send(&payer, &[ix], &[])?;
    for (member, key) in [(0usize, KEY0), (2, KEY2)] {
        let m = members.get(member).ok_or("member")?.insecure_clone();
        env.send(&m, &[create_profile_ix(&m.pubkey(), key)], &[])?;
    }
    let spec = IntentSpec {
        kind: Kind::AttestedResult as u8,
        params: attested_result::Params {
            amount_in: 400,
            min_result: 1,
            max_result: 1,
            attestor: committee.to_bytes(),
            spec_hash: [0x5a; 32],
            judge_fee: 0,
        }
        .encode()
        .map_err(|e| format!("{e:?}"))?,
        ..swap_spec(0, 400)?
    };
    env.create_intent(&trader, &market, &spec)?;
    let intent = intent_pda(&trader.key.pubkey(), 0);
    Ok(World {
        env,
        members,
        committee,
        intent,
    })
}

impl World {
    fn profiles(&self) -> Vec<Pubkey> {
        self.members
            .iter()
            .map(|m| profile_pda(&m.pubkey()))
            .collect()
    }

    fn sync(&mut self) -> TestResult<()> {
        let payer = self.env.funded()?;
        let ix = sync_committee_keys_ix(&self.committee, &self.profiles());
        self.env.send(&payer, &[ix], &[])?;
        Ok(())
    }

    fn announce(&self, worker: &Keypair, blob: Vec<u8>) -> Announce {
        Announce {
            profile: false,
            committee: true,
            ..Announce::new(worker.pubkey(), self.intent, self.committee, blob)
        }
    }

    fn sealed(&self, fps: [[u8; 8]; 3], fill: u8) -> Vec<u8> {
        test_blob(0b101, &fps, 40, fill)
    }
}

#[test]
fn a_committee_takes_announcements_only_after_its_keys_are_synced() -> TestResult {
    let mut w = world()?;
    let worker = w.env.funded()?;
    let early = w.announce(
        &worker,
        w.sealed([fingerprint(&KEY0), [0; 8], fingerprint(&KEY2)], 1),
    );
    assert_eq!(
        w.env.send(&worker, &[early.ix()], &[]).err(),
        Some(engine_error_at(0, EngineError::CommitteeKeysUnsynced))
    );
    let payer = w.env.funded()?;
    let ix = sync_committee_keys_ix(&w.committee, &w.profiles());
    let meta = w.env.send(&payer, &[ix], &[])?;
    let synced: Committee = load(&w.env.svm, &w.committee)?;
    assert_eq!((synced.keys_synced, synced.keys_mask), (1, 0b101));
    assert_eq!(synced.key_fps.first(), Some(&fingerprint(&KEY0)));
    assert_eq!(synced.key_fps.get(1), Some(&[0; 8]));
    assert_eq!(synced.key_fps.get(2), Some(&fingerprint(&KEY2)));
    let emitted = events::<CommitteeKeysSynced>(&meta);
    assert_eq!(emitted.first().map(|e| e.mask), Some(0b101));
    let a = w.announce(
        &worker,
        w.sealed([fingerprint(&KEY0), [0; 8], fingerprint(&KEY2)], 2),
    );
    w.env.send(&worker, &[a.ix()], &[])?;
    Ok(())
}

#[test]
fn syncing_needs_every_member_profile_in_member_order() -> TestResult {
    let mut w = world()?;
    let payer = w.env.funded()?;
    let mut swapped = w.profiles();
    swapped.swap(0, 1);
    assert_eq!(
        w.env
            .send(
                &payer,
                &[sync_committee_keys_ix(&w.committee, &swapped)],
                &[]
            )
            .err(),
        Some(engine_error_at(0, EngineError::ProfileMismatch))
    );
    let short: Vec<Pubkey> = w.profiles().into_iter().take(2).collect();
    assert_eq!(
        w.env
            .send(&payer, &[sync_committee_keys_ix(&w.committee, &short)], &[])
            .err(),
        Some(engine_error_at(0, EngineError::ProfileMismatch))
    );
    Ok(())
}

#[test]
fn a_committee_blob_must_match_the_member_count_mask_and_keys() -> TestResult {
    let mut w = world()?;
    w.sync()?;
    let worker = w.env.funded()?;
    let cases = [
        (
            test_blob(0b01, &[fingerprint(&KEY0), [0; 8]], 40, 1),
            EngineError::BlobRecipients,
        ),
        (
            test_blob(0b001, &[fingerprint(&KEY0), [0; 8], [0; 8]], 40, 2),
            EngineError::BlobKeyMismatch,
        ),
        (
            w.sealed([fingerprint(&KEY0), [0; 8], fingerprint(&[9; 32])], 3),
            EngineError::BlobKeyMismatch,
        ),
    ];
    for (blob, expected) in cases {
        let a = w.announce(&worker, blob);
        assert_eq!(
            w.env.send(&worker, &[a.ix()], &[]).err(),
            Some(engine_error_at(0, expected))
        );
    }
    let mut uncommitted = w.announce(
        &worker,
        w.sealed([fingerprint(&KEY0), [0; 8], fingerprint(&KEY2)], 4),
    );
    uncommitted.committee = false;
    assert_eq!(
        w.env.send(&worker, &[uncommitted.ix()], &[]).err(),
        Some(engine_error_at(0, EngineError::CommitteeMismatch))
    );
    Ok(())
}

#[test]
fn a_rotated_member_key_counts_once_the_committee_syncs_again() -> TestResult {
    let mut w = world()?;
    w.sync()?;
    let member = w.members.get(2).ok_or("member")?.insecure_clone();
    w.env.send(
        &member,
        &[update_profile_ix(&member.pubkey(), [7; 32])],
        &[],
    )?;
    let worker = w.env.funded()?;
    let before = w.announce(
        &worker,
        w.sealed([fingerprint(&KEY0), [0; 8], fingerprint(&KEY2)], 1),
    );
    w.env.send(&worker, &[before.ix()], &[])?;
    w.sync()?;
    let stale = w.announce(
        &worker,
        w.sealed([fingerprint(&KEY0), [0; 8], fingerprint(&KEY2)], 2),
    );
    assert_eq!(
        w.env.send(&worker, &[stale.ix()], &[]).err(),
        Some(engine_error_at(0, EngineError::BlobKeyMismatch))
    );
    let fresh = w.announce(
        &worker,
        w.sealed([fingerprint(&KEY0), [0; 8], fingerprint(&[7; 32])], 3),
    );
    w.env.send(&worker, &[fresh.ix()], &[])?;
    Ok(())
}
