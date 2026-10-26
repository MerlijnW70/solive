use anchor_lang::prelude::Pubkey;
use intent_core::mandate::{LANE_MASK, MANDATE_NONCE_BIT, MAX_LANE_SERIAL};
use intent_core::nonce::NONCE_CEILING;
use intent_engine::errors::EngineError;
use intent_engine::MandateArgs;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    agent_lane, ed25519_ix, engine_error, engine_error_at, granted, intent_pda, kit_terms,
    mandate_pda, swap_at, user_pda, Granted, TestResult, DOMAIN, START_TS,
};

const LOW: u64 = 0xffff_ffff;

fn refused<T>(e: EngineError) -> Result<T, TransactionError> {
    Err(engine_error(e))
}

fn second(s: &mut Granted, id: u64) -> TestResult<(Keypair, Pubkey)> {
    let agent = s.env.funded()?;
    let mandate = s.grant(MandateArgs {
        id,
        agent: agent.pubkey(),
        ..kit_terms()
    })?;
    Ok((agent, mandate))
}

#[test]
fn a_nonce_one_past_either_end_of_the_lane_is_refused() -> TestResult {
    let mut s = granted(kit_terms())?;
    let (other, mandate) = second(&mut s, 0)?;
    assert_eq!((s.serial()?, s.env.mandate(&mandate)?.serial), (1, 2));
    assert_eq!(agent_lane(2, 0) - 1, agent_lane(1, LOW));
    assert_eq!(agent_lane(2, LOW) + 1, agent_lane(3, 0));
    for outside in [agent_lane(2, 0) - 1, agent_lane(2, LOW) + 1] {
        assert_eq!(
            s.creates_under(&other, mandate, &swap_at(outside, 10, 5)?),
            refused(EngineError::MandateMismatch),
            "{outside:#x}"
        );
    }
    assert_eq!(agent_lane(1, 0) - 1, MANDATE_NONCE_BIT | LOW);
    assert_eq!(agent_lane(1, LOW) + 1, agent_lane(2, 0));
    for outside in [agent_lane(1, 0) - 1, agent_lane(1, LOW) + 1] {
        assert_eq!(
            s.agent_creates(&swap_at(outside, 10, 5)?),
            refused(EngineError::MandateMismatch),
            "{outside:#x}"
        );
    }
    for edge in [agent_lane(2, 0), agent_lane(2, LOW)] {
        s.creates_under(&other, mandate, &swap_at(edge, 10, 5)?)?;
    }
    for edge in [agent_lane(1, 0), agent_lane(1, LOW)] {
        s.agent_creates(&swap_at(edge, 10, 5)?)?;
    }
    assert_eq!(s.usage()?, (20, 2));
    assert_eq!(s.env.mandate(&mandate)?.intents, 2);
    Ok(())
}

#[test]
fn two_mandates_of_one_owner_never_accept_the_same_nonce() -> TestResult {
    let mut s = granted(kit_terms())?;
    let first = (s.agent.insecure_clone(), s.mandate);
    let same_agent = s.grant(MandateArgs {
        id: 1,
        agent: s.agent.pubkey(),
        ..kit_terms()
    })?;
    let same = (s.agent.insecure_clone(), same_agent);
    let other = second(&mut s, 0)?;
    let mandates = [first, same, other];
    for (serial, (_, mandate)) in (1..).zip(mandates.iter()) {
        assert_eq!(s.env.mandate(mandate)?.serial, serial);
    }
    for (index, low) in [(0usize, 0u64), (1, 7), (2, LOW), (0, LOW), (1, 0), (2, 3)] {
        let nonce = agent_lane(index as u64 + 1, low);
        for (at, (agent, mandate)) in mandates.iter().enumerate() {
            if at != index {
                assert_eq!(
                    s.creates_under(agent, *mandate, &swap_at(nonce, 10, 5)?),
                    refused(EngineError::MandateMismatch),
                    "{nonce:#x} under mandate {at}"
                );
            }
        }
        let (agent, mandate) = mandates.get(index).ok_or("no mandate")?;
        s.creates_under(agent, *mandate, &swap_at(nonce, 10, 5)?)?;
        assert_eq!(
            s.env.intent(&s.owner(), nonce)?.mandate,
            *mandate,
            "{nonce:#x}"
        );
    }
    for (_, mandate) in &mandates {
        let m = s.env.mandate(mandate)?;
        assert_eq!((m.spent, m.intents), (20, 2));
    }
    Ok(())
}

#[test]
fn a_nonce_the_owner_uses_directly_never_falls_in_a_lane() -> TestResult {
    let mut s = granted(kit_terms())?;
    let owner = s.owner();
    for nonce in [
        MANDATE_NONCE_BIT,
        agent_lane(1, 0),
        agent_lane(1, LOW),
        u64::MAX,
    ] {
        let ix = s
            .env
            .create_intent_ix(&s.trader, &s.market, &swap_at(nonce, 10, 5)?);
        assert_eq!(
            s.owner_sends(&[ix]),
            refused(EngineError::NonceOutOfWindow),
            "{nonce:#x}"
        );
        let signed = swap_at(nonce, 10, 5)?;
        let message = s
            .env
            .signed_message(&s.trader, &s.market, &signed, DOMAIN, START_TS + 60);
        let relayer = s.env.funded()?;
        let ixs = [
            ed25519_ix(&s.trader.key, &message),
            s.env.create_signed_ix(
                &relayer.pubkey(),
                &s.trader,
                &s.market,
                &signed,
                START_TS + 60,
            ),
        ];
        assert_eq!(
            s.env.send(&relayer, &ixs, &[]),
            Err(engine_error_at(1, EngineError::NonceOutOfWindow)),
            "{nonce:#x}"
        );
    }
    let ix = s.env.advance_ix(&owner, MANDATE_NONCE_BIT);
    assert_eq!(
        s.owner_sends(&[ix]),
        refused(EngineError::NonceJumpTooLarge)
    );
    let user = user_pda(&owner);
    let mut account = s.env.svm.get_account(&user).ok_or("user missing")?;
    account
        .data
        .get_mut(40..48)
        .ok_or("user state too short")?
        .copy_from_slice(&(NONCE_CEILING - 1).to_le_bytes());
    s.env.svm.set_account(user, account)?;
    let ix = s.env.advance_ix(&owner, NONCE_CEILING + 1);
    assert_eq!(
        s.owner_sends(&[ix]),
        refused(EngineError::NonceJumpTooLarge)
    );
    let ix = s.env.advance_ix(&owner, NONCE_CEILING);
    s.owner_sends(&[ix])?;
    let highest = MANDATE_NONCE_BIT - 1;
    let ix = s
        .env
        .create_intent_ix(&s.trader, &s.market, &swap_at(highest, 10, 5)?);
    s.owner_sends(&[ix])?;
    for nonce in [highest - 1, NONCE_CEILING, 0] {
        assert_eq!(
            s.agent_creates(&swap_at(nonce, 10, 5)?),
            refused(EngineError::MandateMismatch),
            "{nonce:#x}"
        );
    }
    s.agent_creates(&swap_at(agent_lane(1, 0), 10, 5)?)?;
    assert_eq!(s.env.intent(&owner, highest)?.mandate, Pubkey::default());
    assert_eq!(s.env.intent(&owner, agent_lane(1, 0))?.mandate, s.mandate);
    assert_eq!(s.usage()?, (10, 1));
    Ok(())
}

#[test]
fn the_last_lane_serial_is_granted_and_the_next_grant_is_refused_cleanly() -> TestResult {
    let mut s = granted(kit_terms())?;
    let owner = s.owner();
    s.set_grants(MAX_LANE_SERIAL - 1)?;
    let (last, mandate) = second(&mut s, 0)?;
    assert_eq!(s.env.mandate(&mandate)?.serial, MAX_LANE_SERIAL);
    assert_eq!(s.env.user(&owner)?.grants, MAX_LANE_SERIAL);
    assert_eq!(agent_lane(MAX_LANE_SERIAL, 0), LANE_MASK);
    for nonce in [LANE_MASK, u64::MAX] {
        s.creates_under(&last, mandate, &swap_at(nonce, 10, 5)?)?;
    }
    assert_eq!(
        s.creates_under(&last, mandate, &swap_at(LANE_MASK - 1, 10, 5)?),
        refused(EngineError::MandateMismatch)
    );
    let refused_agent = Keypair::new();
    let before = s.env.lamports(&owner);
    let ix = s.env.create_mandate_ix(
        &s.trader,
        &s.market,
        MandateArgs {
            agent: refused_agent.pubkey(),
            ..kit_terms()
        },
    );
    assert_eq!(s.owner_sends(&[ix]), refused(EngineError::MandateInvalid));
    assert_eq!(s.env.lamports(&owner), before - 5_000);
    assert_eq!(s.env.user(&owner)?.grants, MAX_LANE_SERIAL);
    assert!(!s
        .env
        .exists(&mandate_pda(&owner, &refused_agent.pubkey(), 0)));
    let revoke = s.env.revoke_mandate_ix(&owner, mandate);
    s.owner_sends(&[revoke])?;
    let again = s.env.create_mandate_ix(
        &s.trader,
        &s.market,
        MandateArgs {
            agent: last.pubkey(),
            ..kit_terms()
        },
    );
    assert_eq!(
        s.owner_sends(&[again]),
        refused(EngineError::MandateInvalid)
    );
    assert!(!s.env.exists(&mandate));
    s.agent_creates(&swap_at(agent_lane(1, 0), 10, 5)?)?;
    let balance = s.env.balance(&s.trader.input)?;
    s.cancel(u64::MAX)?;
    assert_eq!(s.env.balance(&s.trader.input)?, balance + 10);
    Ok(())
}

#[test]
fn a_mandate_granted_again_under_the_same_id_after_a_revoke_gets_a_new_lane() -> TestResult {
    let mut s = granted(kit_terms())?;
    let owner = s.owner();
    s.agent_creates(&swap_at(agent_lane(1, 0), 10, 5)?)?;
    s.revoke()?;
    let agent = s.agent.pubkey();
    let regranted = s.grant(MandateArgs {
        agent,
        ..kit_terms()
    })?;
    assert_eq!(regranted, s.mandate);
    assert_eq!((s.serial()?, s.env.user(&owner)?.grants), (2, 2));
    assert_eq!(s.usage()?, (0, 0));
    for old in [agent_lane(1, 1), agent_lane(1, LOW)] {
        assert_eq!(
            s.agent_creates(&swap_at(old, 10, 5)?),
            refused(EngineError::MandateMismatch),
            "{old:#x}"
        );
    }
    s.agent_creates(&swap_at(agent_lane(2, 0), 10, 5)?)?;
    let (filled, _, _) = s.fill(agent_lane(1, 0), 5)?;
    assert_eq!(
        filled.err(),
        Some(engine_error(EngineError::MandateRevoked))
    );
    s.agent_creates(&swap_at(agent_lane(2, 1), 10, 5)?)?;
    assert_eq!(s.env.intent(&owner, agent_lane(2, 1))?.mandate_serial, 2);
    assert_eq!(s.env.intent(&owner, agent_lane(1, 0))?.mandate_serial, 1);
    assert!(s.env.exists(&intent_pda(&owner, agent_lane(1, 0))));
    Ok(())
}
