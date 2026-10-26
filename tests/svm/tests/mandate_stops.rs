use anchor_lang::prelude::Pubkey;
use intent_engine::errors::EngineError;
use intent_engine::events::{AgentPaid, IntentCancelled, IntentExpired, MandateClosed};
use intent_engine::MandateArgs;
use solana_transaction_error::TransactionError;
use svm_tests::{
    agent_lane, anchor_error, engine_error, events, granted, intent_pda, kit_terms, swap_at,
    vault_pda, Granted, IntentSpec, TestResult, KIT_FUNDED, START_TS,
};

const FEE: u64 = 10;
const ESCROW: u64 = 390;
const DRAWN: u64 = ESCROW + FEE;
const MIN_OUT: u64 = 200;
const PROTOCOL_FEE: u64 = 1;
const LAPSES_AT: i64 = START_TS + 100;
const EXPIRES_AT: i64 = START_TS + 600;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Stop {
    Revoke,
    Epoch,
    Lapse,
}

struct Stopped {
    s: Granted,
    agent_to: Pubkey,
    closed: Option<(u64, u32)>,
}

fn lane(n: u64) -> u64 {
    agent_lane(1, n)
}

fn later(nonce: u64) -> TestResult<IntentSpec> {
    Ok(IntentSpec {
        expires_at: EXPIRES_AT + 600,
        ..swap_at(nonce, 10, 5)?
    })
}

fn vault_of(s: &Granted, n: u64) -> TestResult<u64> {
    s.env.balance(&vault_pda(&intent_pda(&s.owner(), lane(n))))
}

fn opened() -> TestResult<(Granted, Pubkey)> {
    let mut s = granted(MandateArgs {
        agent_fee: FEE,
        total: 3 * DRAWN,
        valid_until: LAPSES_AT,
        ..kit_terms()
    })?;
    for n in 0..3 {
        s.agent_creates(&swap_at(lane(n), ESCROW, MIN_OUT)?)?;
        assert_eq!(vault_of(&s, n)?, DRAWN);
        assert_eq!(s.env.intent(&s.owner(), lane(n))?.agent_fee, FEE);
    }
    let agent_to = s.agent_account()?;
    assert_eq!(s.usage()?, (3 * DRAWN, 3));
    assert_eq!(s.env.balance(&s.trader.input)?, KIT_FUNDED - 3 * DRAWN);
    Ok((s, agent_to))
}

fn stopped(stop: Stop) -> TestResult<Stopped> {
    let (mut s, agent_to) = opened()?;
    let closed = match stop {
        Stop::Revoke => {
            let ix = s.env.revoke_mandate_ix(&s.owner(), s.mandate);
            let meta = s.owner_sends(&[ix])?;
            let event = events::<MandateClosed>(&meta)
                .pop()
                .ok_or("missing MandateClosed")?;
            assert!(!s.env.exists(&s.mandate));
            Some((event.spent, event.intents))
        }
        Stop::Epoch => {
            s.advance_epoch()?;
            None
        }
        Stop::Lapse => {
            s.env.set_now(LAPSES_AT);
            None
        }
    };
    Ok(Stopped {
        s,
        agent_to,
        closed,
    })
}

fn refusal_after(stop: Stop) -> TransactionError {
    match stop {
        Stop::Revoke => anchor_error(anchor_lang::error::ErrorCode::AccountOwnedByWrongProgram),
        Stop::Epoch => engine_error(EngineError::MandateRevoked),
        Stop::Lapse => engine_error(EngineError::MandateExpired),
    }
}

fn the_agent_opens_nothing_after(stop: Stop) -> TestResult {
    let Stopped { mut s, .. } = stopped(stop)?;
    let before = s.env.balance(&s.trader.input)?;
    assert_eq!(
        s.agent_creates(&swap_at(lane(3), 10, 5)?).err(),
        Some(refusal_after(stop)),
        "{stop:?}"
    );
    assert!(!s.env.exists(&intent_pda(&s.owner(), lane(3))));
    assert_eq!(s.env.balance(&s.trader.input)?, before);
    if stop != Stop::Revoke {
        assert_eq!(s.usage()?, (3 * DRAWN, 3));
    }
    Ok(())
}

#[test]
fn after_a_revoke_the_agent_opens_no_intent() -> TestResult {
    the_agent_opens_nothing_after(Stop::Revoke)
}

#[test]
fn after_an_epoch_advance_the_agent_opens_no_intent() -> TestResult {
    the_agent_opens_nothing_after(Stop::Epoch)
}

#[test]
fn after_the_mandate_lapses_the_agent_opens_no_intent() -> TestResult {
    the_agent_opens_nothing_after(Stop::Lapse)
}

fn settle_after(stop: Stop) -> TestResult {
    let Stopped {
        mut s,
        agent_to,
        closed,
    } = stopped(stop)?;
    let start = KIT_FUNDED - 3 * DRAWN;
    let (filled, solver, fee_to) = s.fill(lane(0), MIN_OUT)?;
    if stop == Stop::Lapse {
        let meta = filled.map_err(|e| format!("{e:?}"))?;
        let paid = events::<AgentPaid>(&meta)
            .pop()
            .ok_or("missing AgentPaid")?;
        assert_eq!((paid.account, paid.fee), (agent_to, FEE));
        assert_eq!(s.env.balance(&s.trader.receiver)?, MIN_OUT);
        assert_eq!(s.env.balance(&solver.input)?, ESCROW - PROTOCOL_FEE);
        assert_eq!(s.env.balance(&fee_to)?, PROTOCOL_FEE);
        assert_eq!(s.env.balance(&agent_to)?, FEE);
        assert_eq!(vault_of(&s, 0)?, 0);
    } else {
        assert_eq!(
            filled.err(),
            Some(engine_error(EngineError::MandateRevoked)),
            "{stop:?}"
        );
        assert_eq!(s.env.balance(&s.trader.receiver)?, 0);
        assert_eq!(s.env.balance(&solver.input)?, 0);
        assert_eq!(s.env.balance(&fee_to)?, 0);
        assert_eq!(s.env.balance(&agent_to)?, 0);
        assert_eq!(vault_of(&s, 0)?, DRAWN);
    }
    let agent_paid = s.env.balance(&agent_to)?;
    let meta = s.cancel(lane(1)).map_err(|e| format!("{e:?}"))?;
    let cancelled = events::<IntentCancelled>(&meta)
        .pop()
        .ok_or("missing IntentCancelled")?;
    assert_eq!(cancelled.refunded, DRAWN);
    assert_eq!(s.env.balance(&s.trader.input)?, start + DRAWN);
    assert_eq!(vault_of(&s, 1)?, 0);
    assert_eq!(s.env.intent(&s.owner(), lane(1))?.agent_fee, 0);
    assert_eq!(s.env.balance(&agent_to)?, agent_paid);

    assert_eq!(
        s.expire(&s.agent.insecure_clone(), lane(2)).err(),
        Some(engine_error(EngineError::NotExpired))
    );
    s.env.set_now(EXPIRES_AT);
    let cranker = s.env.funded()?;
    let meta = s.expire(&cranker, lane(2)).map_err(|e| format!("{e:?}"))?;
    let expired = events::<IntentExpired>(&meta)
        .pop()
        .ok_or("missing IntentExpired")?;
    assert_eq!(
        (expired.refunded, expired.refund_to),
        (DRAWN, s.trader.input)
    );
    assert_eq!(s.env.balance(&s.trader.input)?, start + 2 * DRAWN);
    assert_eq!(vault_of(&s, 2)?, 0);
    assert_eq!(s.env.intent(&s.owner(), lane(2))?.agent_fee, 0);
    assert_eq!(s.env.balance(&agent_to)?, agent_paid);

    if stop == Stop::Lapse {
        assert_eq!(s.env.balance(&s.trader.input)?, KIT_FUNDED - DRAWN);
    } else {
        s.cancel(lane(0)).map_err(|e| format!("{e:?}"))?;
        assert_eq!(s.env.balance(&s.trader.input)?, KIT_FUNDED);
        assert_eq!(vault_of(&s, 0)?, 0);
        assert_eq!(s.env.balance(&agent_to)?, 0);
    }
    match closed {
        Some(counters) => assert_eq!(counters, (3 * DRAWN, 3)),
        None => assert_eq!(s.usage()?, (3 * DRAWN, 3)),
    }
    Ok(())
}

#[test]
fn intents_opened_before_a_revoke_cannot_fill_and_cancel_and_expire_return_escrow_and_agent_fee_to_the_owner(
) -> TestResult {
    settle_after(Stop::Revoke)
}

#[test]
fn intents_opened_before_an_epoch_advance_cannot_fill_and_cancel_and_expire_return_escrow_and_agent_fee_to_the_owner(
) -> TestResult {
    settle_after(Stop::Epoch)
}

#[test]
fn intents_opened_before_the_mandate_lapses_still_fill_paying_the_agent_and_cancel_and_expire_refund_the_owner(
) -> TestResult {
    settle_after(Stop::Lapse)
}

#[test]
fn cancel_and_expire_leave_the_mandates_spent_and_intents_unchanged_so_neither_limit_refills(
) -> TestResult {
    let mut s = granted(MandateArgs {
        agent_fee: FEE,
        total: 3 * DRAWN,
        ..kit_terms()
    })?;
    for n in 0..3 {
        s.agent_creates(&swap_at(lane(n), ESCROW, MIN_OUT)?)?;
    }
    s.cancel(lane(0)).map_err(|e| format!("{e:?}"))?;
    assert_eq!(s.usage()?, (3 * DRAWN, 3));
    assert_eq!(
        s.agent_creates(&swap_at(lane(3), 1, 6)?),
        Err(engine_error(EngineError::MandateBudget))
    );
    s.env.set_now(EXPIRES_AT);
    let cranker = s.env.funded()?;
    s.expire(&cranker, lane(1)).map_err(|e| format!("{e:?}"))?;
    assert_eq!(s.usage()?, (3 * DRAWN, 3));
    assert_eq!(s.env.balance(&s.trader.input)?, KIT_FUNDED - DRAWN);

    let mut counted = granted(MandateArgs {
        max_intents: 2,
        ..kit_terms()
    })?;
    counted.agent_creates(&swap_at(lane(0), 10, 5)?)?;
    counted.agent_creates(&swap_at(lane(1), 10, 5)?)?;
    counted.cancel(lane(0)).map_err(|e| format!("{e:?}"))?;
    counted.env.set_now(EXPIRES_AT);
    let cranker = counted.env.funded()?;
    counted
        .expire(&cranker, lane(1))
        .map_err(|e| format!("{e:?}"))?;
    assert_eq!(counted.usage()?, (20, 2));
    assert_eq!(
        counted.agent_creates(&later(lane(2))?),
        Err(engine_error(EngineError::MandateCount))
    );
    assert_eq!(counted.env.balance(&counted.trader.input)?, KIT_FUNDED);
    Ok(())
}
