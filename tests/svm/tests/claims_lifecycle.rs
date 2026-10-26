use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use intent_engine::errors::EngineError;
use litesvm::types::TransactionMetadata;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    anchor_error_at, engine_error_at, ClaimWorld, ReleasePath, ReleaseTerms, TestResult, START_TS,
};

const STAKE: u64 = 50_000_000;
const HOUR: u32 = 3_600;
const HOLD: u32 = 600;
const SHORT: u32 = 60;
const FRESH_SECS: u32 = 300;
const LINE_SECS: [u32; 3] = [900, 1_200, 1_500];
const TERMS: ReleaseTerms = ReleaseTerms {
    funded: 1_000_000,
    escrow: 100_000,
    judge_fee: 0,
    spec: [0x6c; 32],
    weights: [6_000, 4_000],
    partner_bps: 0,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Free,
    Held,
    Lapsed,
    LineOfOne,
    LineOfThree,
    DroppedWithLine,
}

const STATES: [State; 6] = [
    State::Free,
    State::Held,
    State::Lapsed,
    State::LineOfOne,
    State::LineOfThree,
    State::DroppedWithLine,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Party {
    Holder,
    A,
    B,
    Fresh,
    Stranger,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Event {
    NewClaim,
    StandBy,
    Leave,
    Advance,
    Drop,
    PayHolder(ReleasePath),
    PayOther(ReleasePath),
    Cancel,
    Expire,
    SettleOpen,
    SettleEnded,
    Close,
}

impl Event {
    fn path(self) -> ReleasePath {
        match self {
            Self::PayHolder(path) | Self::PayOther(path) => path,
            _ => ReleasePath::Attested,
        }
    }

    fn releases(self) -> bool {
        matches!(self, Self::PayHolder(_) | Self::PayOther(_))
    }

    fn index(self) -> u8 {
        u8::from(self.releases())
    }
}

#[derive(Clone, Copy, Debug)]
enum Expect {
    Done,
    Refused(EngineError),
    Missing(ErrorCode),
}

use Expect::{Done, Missing, Refused};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Lamports {
    stakes: i64,
    rents: i64,
}

const fn s(stakes: i64) -> Lamports {
    Lamports { stakes, rents: 0 }
}

const fn sr(stakes: i64, rents: i64) -> Lamports {
    Lamports { stakes, rents }
}

const Z: Lamports = s(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Ledger {
    owner: Lamports,
    holder: Lamports,
    a: Lamports,
    b: Lamports,
    c: Lamports,
    fresh: Lamports,
}

const EVEN: Ledger = Ledger {
    owner: Z,
    holder: Z,
    a: Z,
    b: Z,
    c: Z,
    fresh: Z,
};

const FORFEITED: Ledger = Ledger {
    owner: s(1),
    holder: s(-1),
    ..EVEN
};

const FRESH_FORFEITS: Ledger = Ledger {
    owner: s(1),
    fresh: s(-1),
    ..EVEN
};

const BOTH_FORFEIT: Ledger = Ledger {
    owner: s(2),
    holder: s(-1),
    fresh: s(-1),
    ..EVEN
};

type Probe = &'static [(Party, Expect)];

const OPEN_JOB: Probe = &[
    (Party::Stranger, Refused(EngineError::NotListed)),
    (Party::Fresh, Done),
];
const HELD_JOB: Probe = &[
    (Party::Stranger, Refused(EngineError::NotListed)),
    (Party::Fresh, Refused(EngineError::ClaimHeld)),
];
const TAKEN: Probe = &[
    (Party::Stranger, Refused(EngineError::NotListed)),
    (Party::Holder, Refused(EngineError::ClaimHeld)),
];
const WAITING_LINE: Probe = &[
    (Party::Stranger, Refused(EngineError::NotListed)),
    (Party::Fresh, Refused(EngineError::LineWaiting)),
];
const DROPPER_WAITS: Probe = &[
    (Party::Stranger, Refused(EngineError::NotListed)),
    (Party::Holder, Refused(EngineError::LineWaiting)),
    (Party::Fresh, Refused(EngineError::LineWaiting)),
];
const DROPPED_JOB: Probe = &[
    (Party::Stranger, Refused(EngineError::NotListed)),
    (Party::Holder, Refused(EngineError::ClaimCooldown)),
    (Party::Fresh, Done),
];
const ENDED: Probe = &[
    (Party::Stranger, Refused(EngineError::InvalidTransition)),
    (Party::Holder, Refused(EngineError::InvalidTransition)),
    (Party::Fresh, Refused(EngineError::InvalidTransition)),
];
const NO_INTENT: Probe = &[
    (
        Party::Stranger,
        Missing(ErrorCode::AccountOwnedByWrongProgram),
    ),
    (Party::Fresh, Missing(ErrorCode::AccountOwnedByWrongProgram)),
];
const NO_BOARD: Probe = &[
    (
        Party::Stranger,
        Missing(ErrorCode::AccountOwnedByWrongProgram),
    ),
    (
        Party::Holder,
        Missing(ErrorCode::AccountOwnedByWrongProgram),
    ),
    (Party::Fresh, Missing(ErrorCode::AccountOwnedByWrongProgram)),
];

#[derive(Clone, Copy, Debug)]
struct Case {
    state: State,
    expect: Expect,
    moved: Ledger,
    holds: Option<Party>,
    board: Option<(u32, u32)>,
    probe: Probe,
    nets: Ledger,
}

struct Cast {
    holder: Keypair,
    a: Keypair,
    b: Keypair,
    c: Keypair,
    fresh: Keypair,
    stranger: Keypair,
}

impl Cast {
    fn key(&self, party: Party) -> &Keypair {
        match party {
            Party::Holder => &self.holder,
            Party::A => &self.a,
            Party::B => &self.b,
            Party::Fresh => &self.fresh,
            Party::Stranger => &self.stranger,
        }
    }

    fn by_key(&self, key: &Pubkey) -> Option<&Keypair> {
        [&self.holder, &self.a, &self.b, &self.c, &self.fresh]
            .into_iter()
            .find(|k| k.pubkey() == *key)
    }

    fn secs(&self, party: Party) -> Option<u32> {
        match party {
            Party::A => LINE_SECS.first().copied(),
            Party::B => LINE_SECS.get(1).copied(),
            Party::Fresh => Some(FRESH_SECS),
            Party::Holder | Party::Stranger => None,
        }
    }
}

struct Run {
    world: ClaimWorld,
    cast: Cast,
}

fn amount(lamports: Lamports, stake: u64, rent: u64) -> TestResult<i128> {
    let stakes = i128::from(lamports.stakes)
        .checked_mul(i128::from(stake))
        .ok_or("overflow")?;
    let rents = i128::from(lamports.rents)
        .checked_mul(i128::from(rent))
        .ok_or("overflow")?;
    Ok(stakes.checked_add(rents).ok_or("overflow")?)
}

fn refusal(expect: Expect, index: u8) -> Option<TransactionError> {
    match expect {
        Done => None,
        Refused(e) => Some(engine_error_at(index, e)),
        Missing(code) => Some(anchor_error_at(index, code)),
    }
}

fn outcome(
    sent: &Result<TransactionMetadata, TransactionError>,
    expect: Expect,
    index: u8,
    what: &str,
) -> TestResult {
    let got = sent.as_ref().err().cloned();
    let want = refusal(expect, index);
    if got != want {
        return Err(format!("{what}: got {got:?}, expected {want:?}").into());
    }
    Ok(())
}

impl Run {
    fn new(event: Event, listed: bool) -> TestResult<Self> {
        let mut world = ClaimWorld::new(event.path(), TERMS)?;
        let payee = world.release.workers[0].insecure_clone();
        let holder = match event {
            Event::PayOther(_) => world.funded()?,
            _ => payee.insecure_clone(),
        };
        let cast = Cast {
            holder,
            a: world.funded()?,
            b: world.funded()?,
            c: world.funded()?,
            fresh: world.funded()?,
            stranger: world.funded()?,
        };
        let mut roster = vec![
            payee.pubkey(),
            world.release.workers[1].pubkey(),
            cast.a.pubkey(),
            cast.b.pubkey(),
            cast.c.pubkey(),
            cast.fresh.pubkey(),
        ];
        if !roster.contains(&cast.holder.pubkey()) {
            roster.push(cast.holder.pubkey());
        }
        world
            .open(HOUR, STAKE, listed.then_some(roster.as_slice()))
            .map_err(|e| format!("open: {e:?}"))?;
        if event.releases() {
            world.announce(&payee)?;
        }
        Ok(Self { world, cast })
    }

    fn pubkey(&self, party: Party) -> Pubkey {
        self.cast.key(party).pubkey()
    }

    fn balances(&self) -> [u64; 6] {
        let w = &self.world;
        [
            w.lamports(&w.owner()),
            w.lamports(&self.cast.holder.pubkey()),
            w.lamports(&self.cast.a.pubkey()),
            w.lamports(&self.cast.b.pubkey()),
            w.lamports(&self.cast.c.pubkey()),
            w.lamports(&self.cast.fresh.pubkey()),
        ]
    }

    fn line_secs(&self, index: usize) -> TestResult<u32> {
        Ok(*LINE_SECS.get(index).ok_or("no such waiter")?)
    }

    fn build(&mut self, state: State) -> TestResult {
        let holder = self.cast.holder.insecure_clone();
        let waiters = [
            self.cast.a.insecure_clone(),
            self.cast.b.insecure_clone(),
            self.cast.c.insecure_clone(),
        ];
        let line = match state {
            State::Free => return Ok(()),
            State::Lapsed => {
                self.world
                    .claim(&holder, SHORT)
                    .map_err(|e| format!("{e:?}"))?;
                self.world
                    .set_now(START_TS.checked_add(i64::from(SHORT)).ok_or("overflow")?);
                return Ok(());
            }
            State::Held => 0,
            State::LineOfOne => 1,
            State::LineOfThree => 3,
            State::DroppedWithLine => 2,
        };
        self.world
            .claim(&holder, HOLD)
            .map_err(|e| format!("{e:?}"))?;
        for (i, waiter) in waiters.iter().take(line).enumerate() {
            let secs = self.line_secs(i)?;
            self.world
                .stand_by(waiter, secs)?
                .map_err(|e| format!("stand by: {e:?}"))?;
        }
        if state == State::DroppedWithLine {
            let a = &waiters[0];
            self.world
                .leave(a, 0, &a.pubkey())
                .map_err(|e| format!("leave: {e:?}"))?;
            self.world
                .drop_with(&holder, &[0], None)
                .map_err(|e| format!("drop: {e:?}"))?;
        }
        Ok(())
    }

    fn stake_to(&self, state: State) -> Option<Pubkey> {
        match state {
            State::Held | State::LineOfOne | State::LineOfThree => Some(self.cast.holder.pubkey()),
            State::Lapsed => Some(self.world.owner()),
            State::Free | State::DroppedWithLine => None,
        }
    }

    fn apply(
        &mut self,
        event: Event,
        state: State,
    ) -> TestResult<(Result<TransactionMetadata, TransactionError>, u64)> {
        let fresh = self.cast.fresh.insecure_clone();
        let holder = self.cast.holder.insecure_clone();
        let stake_to = self.stake_to(state);
        Ok(match event {
            Event::NewClaim => (self.world.claim(&fresh, FRESH_SECS), 0),
            Event::StandBy => (self.world.stand_by(&fresh, FRESH_SECS)?, 0),
            Event::Leave => {
                let tail = self.world.board()?.tail;
                let first =
                    (0..tail).find_map(|seq| self.world.entry(seq).map(|e| (seq, e.worker)));
                let (seq, worker) = first.unwrap_or((0, self.cast.a.pubkey()));
                let caller = self
                    .cast
                    .by_key(&worker)
                    .ok_or("unknown waiter")?
                    .insecure_clone();
                (self.world.leave(&caller, seq, &worker), 0)
            }
            Event::Advance => (self.world.advance()?, 0),
            Event::Drop => (self.world.drop_claim(&holder)?, 0),
            Event::PayHolder(path) | Event::PayOther(path) => {
                (self.world.release_to(path, stake_to.as_ref())?, 0)
            }
            Event::Cancel => (self.world.cancel(stake_to.as_ref()), 0),
            Event::Expire => {
                let expires_at = self.world.expires_at()?;
                self.world.set_now(expires_at);
                (self.world.expire(), 0)
            }
            Event::SettleOpen => (self.world.settle()?, 0),
            Event::SettleEnded => {
                let expires_at = self.world.expires_at()?;
                self.world.set_now(expires_at);
                (self.world.settle()?, 0)
            }
            Event::Close => {
                let expires_at = self.world.expires_at()?;
                self.world.set_now(expires_at);
                outcome(
                    &self.world.close(),
                    Refused(EngineError::InvalidTransition),
                    0,
                    "close before the escrow is expired",
                )?;
                self.world.expire().map_err(|e| format!("expire: {e:?}"))?;
                let intent = self.world.intent();
                let vault = svm_tests::vault_pda(&intent);
                let rents = self
                    .world
                    .lamports(&intent)
                    .checked_add(self.world.lamports(&vault))
                    .ok_or("overflow")?;
                (self.world.close(), rents)
            }
        })
    }

    fn compare(
        &self,
        what: &str,
        before: [u64; 6],
        ledger: Ledger,
        owner_extra: u64,
    ) -> TestResult {
        let after = self.balances();
        let stake = STAKE;
        let rent = self.world.entry_rent();
        let parties = [
            ("owner", ledger.owner, owner_extra),
            ("holder", ledger.holder, 0),
            ("a", ledger.a, 0),
            ("b", ledger.b, 0),
            ("c", ledger.c, 0),
            ("fresh", ledger.fresh, 0),
        ];
        for (i, (name, lamports, extra)) in parties.into_iter().enumerate() {
            let was = i128::from(*before.get(i).ok_or("balance")?);
            let now = i128::from(*after.get(i).ok_or("balance")?);
            let want = amount(lamports, stake, rent)?
                .checked_add(i128::from(extra))
                .ok_or("overflow")?;
            let moved = now.checked_sub(was).ok_or("overflow")?;
            if moved != want {
                return Err(format!("{what}: {name} moved {moved}, expected {want}").into());
            }
        }
        Ok(())
    }

    fn check_board(&self, case: &Case, event_now: i64, until_before: i64) -> TestResult {
        let w = &self.world;
        let Some((head, tail)) = case.board else {
            if w.exists(&w.board_key()) || w.exists(&w.list_key()) {
                return Err("the board or list outlived the event".into());
            }
            return Ok(());
        };
        let board = w.board()?;
        if (board.head, board.tail) != (head, tail) {
            return Err(format!(
                "line is {:?}, expected {:?}",
                (board.head, board.tail),
                (head, tail)
            )
            .into());
        }
        let worker = case.holds.map(|p| self.pubkey(p)).unwrap_or_default();
        if board.worker != worker {
            return Err(
                format!("board held by {}, expected {:?}", board.worker, case.holds).into(),
            );
        }
        let held = if case.holds.is_some() { STAKE } else { 0 };
        if board.held != held {
            return Err(format!("board holds a stake of {}, expected {held}", board.held).into());
        }
        let until = match case.holds {
            Some(Party::Holder) => Some(until_before),
            Some(party) => {
                let secs = self.cast.secs(party).ok_or("no recorded time")?;
                Some(
                    event_now
                        .checked_add(i64::from(secs))
                        .ok_or("overflow")?
                        .min(w.expires_at()?),
                )
            }
            None => None,
        };
        if let Some(until) = until {
            if board.until != until {
                return Err(format!("claim runs until {}, expected {until}", board.until).into());
            }
        }
        Ok(())
    }

    fn probe(&mut self, probe: Probe, listed: bool) -> TestResult {
        for (party, expect) in probe {
            if *party == Party::Stranger && !listed {
                continue;
            }
            let who = self.cast.key(*party).insecure_clone();
            let sent = self.world.claim(&who, FRESH_SECS);
            outcome(&sent, *expect, 0, &format!("{party:?} claims next"))?;
            self.world.check_holdings(STAKE)?;
        }
        Ok(())
    }
}

fn run_case(event: Event, case: &Case, listed: bool) -> TestResult {
    let mut run = Run::new(event, listed)?;
    let start = run.balances();
    run.build(case.state)?;
    run.world.check_holdings(STAKE)?;
    let before = run.balances();
    let had_board = run.world.exists(&run.world.board_key());
    let until_before = run.world.board()?.until;
    let (sent, close_rents) = run.apply(event, case.state)?;
    let event_now = run.world.now();
    outcome(&sent, case.expect, event.index(), "event")?;
    let returned = if had_board && !run.world.exists(&run.world.board_key()) {
        run.world
            .board_rent()
            .checked_add(run.world.list_rent())
            .ok_or("overflow")?
    } else {
        0
    };
    let owner_extra = returned.checked_add(close_rents).ok_or("overflow")?;
    run.compare("event", before, case.moved, owner_extra)?;
    run.world.check_holdings(STAKE)?;
    run.check_board(case, event_now, until_before)?;
    run.probe(case.probe, listed)?;
    run.world.wind_up()?;
    let rents = run
        .world
        .board_rent()
        .checked_add(run.world.list_rent())
        .and_then(|r| r.checked_add(close_rents))
        .ok_or("overflow")?;
    run.compare("after the end", start, case.nets, rents)
}

fn run(event: Event, cases: &[Case; 6]) -> TestResult {
    let states: Vec<State> = cases.iter().map(|c| c.state).collect();
    assert_eq!(states, STATES, "one case per board state, in order");
    for case in cases {
        for listed in [false, true] {
            run_case(event, case, listed).map_err(|e| {
                let board = if listed { "listed" } else { "open" };
                format!("{event:?} on a {board} board, {:?}: {e}", case.state)
            })?;
        }
    }
    Ok(())
}

fn stake_back_to_holder() -> [Case; 6] {
    [
        Case {
            state: State::Free,
            expect: Done,
            moved: EVEN,
            holds: None,
            board: Some((0, 0)),
            probe: ENDED,
            nets: EVEN,
        },
        Case {
            state: State::Held,
            expect: Done,
            moved: Ledger {
                holder: s(1),
                ..EVEN
            },
            holds: None,
            board: Some((0, 0)),
            probe: ENDED,
            nets: EVEN,
        },
        Case {
            state: State::Lapsed,
            expect: Done,
            moved: Ledger {
                owner: s(1),
                ..EVEN
            },
            holds: None,
            board: Some((0, 0)),
            probe: ENDED,
            nets: FORFEITED,
        },
        Case {
            state: State::LineOfOne,
            expect: Done,
            moved: Ledger {
                holder: s(1),
                ..EVEN
            },
            holds: None,
            board: Some((0, 1)),
            probe: ENDED,
            nets: EVEN,
        },
        Case {
            state: State::LineOfThree,
            expect: Done,
            moved: Ledger {
                holder: s(1),
                ..EVEN
            },
            holds: None,
            board: Some((0, 3)),
            probe: ENDED,
            nets: EVEN,
        },
        Case {
            state: State::DroppedWithLine,
            expect: Done,
            moved: EVEN,
            holds: None,
            board: Some((1, 2)),
            probe: ENDED,
            nets: EVEN,
        },
    ]
}

fn paid_past_the_holder() -> [Case; 6] {
    [
        Case {
            state: State::Free,
            expect: Done,
            moved: EVEN,
            holds: None,
            board: Some((0, 0)),
            probe: ENDED,
            nets: EVEN,
        },
        Case {
            state: State::Held,
            expect: Refused(EngineError::ClaimHeld),
            moved: EVEN,
            holds: Some(Party::Holder),
            board: Some((0, 0)),
            probe: HELD_JOB,
            nets: FORFEITED,
        },
        Case {
            state: State::Lapsed,
            expect: Done,
            moved: Ledger {
                owner: s(1),
                ..EVEN
            },
            holds: None,
            board: Some((0, 0)),
            probe: ENDED,
            nets: FORFEITED,
        },
        Case {
            state: State::LineOfOne,
            expect: Refused(EngineError::ClaimHeld),
            moved: EVEN,
            holds: Some(Party::Holder),
            board: Some((0, 1)),
            probe: WAITING_LINE,
            nets: FORFEITED,
        },
        Case {
            state: State::LineOfThree,
            expect: Refused(EngineError::ClaimHeld),
            moved: EVEN,
            holds: Some(Party::Holder),
            board: Some((0, 3)),
            probe: WAITING_LINE,
            nets: FORFEITED,
        },
        Case {
            state: State::DroppedWithLine,
            expect: Done,
            moved: EVEN,
            holds: None,
            board: Some((1, 2)),
            probe: ENDED,
            nets: EVEN,
        },
    ]
}

#[test]
fn a_new_claim_against_every_board_state() -> TestResult {
    run(
        Event::NewClaim,
        &[
            Case {
                state: State::Free,
                expect: Done,
                moved: Ledger {
                    fresh: s(-1),
                    ..EVEN
                },
                holds: Some(Party::Fresh),
                board: Some((0, 0)),
                probe: TAKEN,
                nets: FRESH_FORFEITS,
            },
            Case {
                state: State::Held,
                expect: Refused(EngineError::ClaimHeld),
                moved: EVEN,
                holds: Some(Party::Holder),
                board: Some((0, 0)),
                probe: HELD_JOB,
                nets: FORFEITED,
            },
            Case {
                state: State::Lapsed,
                expect: Done,
                moved: Ledger {
                    owner: s(1),
                    fresh: s(-1),
                    ..EVEN
                },
                holds: Some(Party::Fresh),
                board: Some((0, 0)),
                probe: TAKEN,
                nets: BOTH_FORFEIT,
            },
            Case {
                state: State::LineOfOne,
                expect: Refused(EngineError::LineWaiting),
                moved: EVEN,
                holds: Some(Party::Holder),
                board: Some((0, 1)),
                probe: WAITING_LINE,
                nets: FORFEITED,
            },
            Case {
                state: State::LineOfThree,
                expect: Refused(EngineError::LineWaiting),
                moved: EVEN,
                holds: Some(Party::Holder),
                board: Some((0, 3)),
                probe: WAITING_LINE,
                nets: FORFEITED,
            },
            Case {
                state: State::DroppedWithLine,
                expect: Refused(EngineError::LineWaiting),
                moved: EVEN,
                holds: None,
                board: Some((1, 2)),
                probe: DROPPER_WAITS,
                nets: EVEN,
            },
        ],
    )
}

#[test]
fn standing_by_against_every_board_state() -> TestResult {
    let joined = Ledger {
        fresh: sr(-1, -1),
        ..EVEN
    };
    run(
        Event::StandBy,
        &[
            Case {
                state: State::Free,
                expect: Refused(EngineError::JobNotHeld),
                moved: EVEN,
                holds: None,
                board: Some((0, 0)),
                probe: OPEN_JOB,
                nets: FRESH_FORFEITS,
            },
            Case {
                state: State::Held,
                expect: Done,
                moved: joined,
                holds: Some(Party::Holder),
                board: Some((0, 1)),
                probe: WAITING_LINE,
                nets: FORFEITED,
            },
            Case {
                state: State::Lapsed,
                expect: Refused(EngineError::JobNotHeld),
                moved: EVEN,
                holds: Some(Party::Holder),
                board: Some((0, 0)),
                probe: OPEN_JOB,
                nets: BOTH_FORFEIT,
            },
            Case {
                state: State::LineOfOne,
                expect: Done,
                moved: joined,
                holds: Some(Party::Holder),
                board: Some((0, 2)),
                probe: WAITING_LINE,
                nets: FORFEITED,
            },
            Case {
                state: State::LineOfThree,
                expect: Done,
                moved: joined,
                holds: Some(Party::Holder),
                board: Some((0, 4)),
                probe: WAITING_LINE,
                nets: FORFEITED,
            },
            Case {
                state: State::DroppedWithLine,
                expect: Done,
                moved: joined,
                holds: None,
                board: Some((1, 3)),
                probe: WAITING_LINE,
                nets: EVEN,
            },
        ],
    )
}

#[test]
fn leaving_the_line_against_every_board_state() -> TestResult {
    let nothing_to_leave = Missing(ErrorCode::AccountOwnedByWrongProgram);
    run(
        Event::Leave,
        &[
            Case {
                state: State::Free,
                expect: nothing_to_leave,
                moved: EVEN,
                holds: None,
                board: Some((0, 0)),
                probe: OPEN_JOB,
                nets: FRESH_FORFEITS,
            },
            Case {
                state: State::Held,
                expect: nothing_to_leave,
                moved: EVEN,
                holds: Some(Party::Holder),
                board: Some((0, 0)),
                probe: HELD_JOB,
                nets: FORFEITED,
            },
            Case {
                state: State::Lapsed,
                expect: nothing_to_leave,
                moved: EVEN,
                holds: Some(Party::Holder),
                board: Some((0, 0)),
                probe: OPEN_JOB,
                nets: BOTH_FORFEIT,
            },
            Case {
                state: State::LineOfOne,
                expect: Done,
                moved: Ledger {
                    a: sr(1, 1),
                    ..EVEN
                },
                holds: Some(Party::Holder),
                board: Some((0, 1)),
                probe: WAITING_LINE,
                nets: FORFEITED,
            },
            Case {
                state: State::LineOfThree,
                expect: Done,
                moved: Ledger {
                    a: sr(1, 1),
                    ..EVEN
                },
                holds: Some(Party::Holder),
                board: Some((0, 3)),
                probe: WAITING_LINE,
                nets: FORFEITED,
            },
            Case {
                state: State::DroppedWithLine,
                expect: Done,
                moved: Ledger {
                    b: sr(1, 1),
                    ..EVEN
                },
                holds: None,
                board: Some((1, 2)),
                probe: WAITING_LINE,
                nets: EVEN,
            },
        ],
    )
}

#[test]
fn advancing_the_line_against_every_board_state() -> TestResult {
    run(
        Event::Advance,
        &[
            Case {
                state: State::Free,
                expect: Refused(EngineError::LineEmpty),
                moved: EVEN,
                holds: None,
                board: Some((0, 0)),
                probe: OPEN_JOB,
                nets: FRESH_FORFEITS,
            },
            Case {
                state: State::Held,
                expect: Refused(EngineError::ClaimHeld),
                moved: EVEN,
                holds: Some(Party::Holder),
                board: Some((0, 0)),
                probe: HELD_JOB,
                nets: FORFEITED,
            },
            Case {
                state: State::Lapsed,
                expect: Refused(EngineError::LineEmpty),
                moved: EVEN,
                holds: Some(Party::Holder),
                board: Some((0, 0)),
                probe: OPEN_JOB,
                nets: BOTH_FORFEIT,
            },
            Case {
                state: State::LineOfOne,
                expect: Refused(EngineError::ClaimHeld),
                moved: EVEN,
                holds: Some(Party::Holder),
                board: Some((0, 1)),
                probe: WAITING_LINE,
                nets: FORFEITED,
            },
            Case {
                state: State::LineOfThree,
                expect: Refused(EngineError::ClaimHeld),
                moved: EVEN,
                holds: Some(Party::Holder),
                board: Some((0, 3)),
                probe: WAITING_LINE,
                nets: FORFEITED,
            },
            Case {
                state: State::DroppedWithLine,
                expect: Done,
                moved: Ledger {
                    b: sr(0, 1),
                    ..EVEN
                },
                holds: Some(Party::B),
                board: Some((2, 2)),
                probe: TAKEN,
                nets: Ledger {
                    owner: s(1),
                    b: s(-1),
                    ..EVEN
                },
            },
        ],
    )
}

#[test]
fn dropping_the_claim_against_every_board_state() -> TestResult {
    let handed_to_a = Ledger {
        holder: s(1),
        a: sr(0, 1),
        ..EVEN
    };
    let a_forfeits = Ledger {
        owner: s(1),
        a: s(-1),
        ..EVEN
    };
    run(
        Event::Drop,
        &[
            Case {
                state: State::Free,
                expect: Refused(EngineError::NotClaimant),
                moved: EVEN,
                holds: None,
                board: Some((0, 0)),
                probe: OPEN_JOB,
                nets: FRESH_FORFEITS,
            },
            Case {
                state: State::Held,
                expect: Done,
                moved: Ledger {
                    holder: s(1),
                    ..EVEN
                },
                holds: None,
                board: Some((0, 0)),
                probe: DROPPED_JOB,
                nets: FRESH_FORFEITS,
            },
            Case {
                state: State::Lapsed,
                expect: Refused(EngineError::NotClaimant),
                moved: EVEN,
                holds: Some(Party::Holder),
                board: Some((0, 0)),
                probe: OPEN_JOB,
                nets: BOTH_FORFEIT,
            },
            Case {
                state: State::LineOfOne,
                expect: Done,
                moved: handed_to_a,
                holds: Some(Party::A),
                board: Some((1, 1)),
                probe: TAKEN,
                nets: a_forfeits,
            },
            Case {
                state: State::LineOfThree,
                expect: Done,
                moved: handed_to_a,
                holds: Some(Party::A),
                board: Some((1, 3)),
                probe: DROPPER_WAITS,
                nets: a_forfeits,
            },
            Case {
                state: State::DroppedWithLine,
                expect: Refused(EngineError::NotClaimant),
                moved: EVEN,
                holds: None,
                board: Some((1, 2)),
                probe: DROPPER_WAITS,
                nets: EVEN,
            },
        ],
    )
}

#[test]
fn an_attested_release_to_the_holder_against_every_board_state() -> TestResult {
    run(
        Event::PayHolder(ReleasePath::Attested),
        &stake_back_to_holder(),
    )
}

#[test]
fn an_attested_release_to_someone_else_against_every_board_state() -> TestResult {
    run(
        Event::PayOther(ReleasePath::Attested),
        &paid_past_the_holder(),
    )
}

#[test]
fn a_split_release_naming_the_holder_against_every_board_state() -> TestResult {
    run(
        Event::PayHolder(ReleasePath::AttestedSplit),
        &stake_back_to_holder(),
    )
}

#[test]
fn a_split_release_without_the_holder_against_every_board_state() -> TestResult {
    run(
        Event::PayOther(ReleasePath::AttestedSplit),
        &paid_past_the_holder(),
    )
}

#[test]
fn a_committee_release_against_every_board_state() -> TestResult {
    run(
        Event::PayHolder(ReleasePath::Committee),
        &stake_back_to_holder(),
    )
}

#[test]
fn a_cancel_against_every_board_state() -> TestResult {
    run(Event::Cancel, &stake_back_to_holder())
}

#[test]
fn an_expiry_against_every_board_state() -> TestResult {
    run(
        Event::Expire,
        &[
            Case {
                state: State::Free,
                expect: Done,
                moved: EVEN,
                holds: None,
                board: Some((0, 0)),
                probe: ENDED,
                nets: EVEN,
            },
            Case {
                state: State::Held,
                expect: Done,
                moved: EVEN,
                holds: Some(Party::Holder),
                board: Some((0, 0)),
                probe: ENDED,
                nets: FORFEITED,
            },
            Case {
                state: State::Lapsed,
                expect: Done,
                moved: EVEN,
                holds: Some(Party::Holder),
                board: Some((0, 0)),
                probe: ENDED,
                nets: FORFEITED,
            },
            Case {
                state: State::LineOfOne,
                expect: Done,
                moved: EVEN,
                holds: Some(Party::Holder),
                board: Some((0, 1)),
                probe: ENDED,
                nets: FORFEITED,
            },
            Case {
                state: State::LineOfThree,
                expect: Done,
                moved: EVEN,
                holds: Some(Party::Holder),
                board: Some((0, 3)),
                probe: ENDED,
                nets: FORFEITED,
            },
            Case {
                state: State::DroppedWithLine,
                expect: Done,
                moved: EVEN,
                holds: None,
                board: Some((1, 2)),
                probe: ENDED,
                nets: EVEN,
            },
        ],
    )
}

#[test]
fn settling_claims_on_an_open_escrow_against_every_board_state() -> TestResult {
    run(
        Event::SettleOpen,
        &[
            Case {
                state: State::Free,
                expect: Refused(EngineError::InvalidTransition),
                moved: EVEN,
                holds: None,
                board: Some((0, 0)),
                probe: OPEN_JOB,
                nets: FRESH_FORFEITS,
            },
            Case {
                state: State::Held,
                expect: Refused(EngineError::ClaimHeld),
                moved: EVEN,
                holds: Some(Party::Holder),
                board: Some((0, 0)),
                probe: HELD_JOB,
                nets: FORFEITED,
            },
            Case {
                state: State::Lapsed,
                expect: Done,
                moved: Ledger {
                    owner: s(1),
                    ..EVEN
                },
                holds: None,
                board: Some((0, 0)),
                probe: OPEN_JOB,
                nets: BOTH_FORFEIT,
            },
            Case {
                state: State::LineOfOne,
                expect: Refused(EngineError::ClaimHeld),
                moved: EVEN,
                holds: Some(Party::Holder),
                board: Some((0, 1)),
                probe: WAITING_LINE,
                nets: FORFEITED,
            },
            Case {
                state: State::LineOfThree,
                expect: Refused(EngineError::ClaimHeld),
                moved: EVEN,
                holds: Some(Party::Holder),
                board: Some((0, 3)),
                probe: WAITING_LINE,
                nets: FORFEITED,
            },
            Case {
                state: State::DroppedWithLine,
                expect: Refused(EngineError::InvalidTransition),
                moved: EVEN,
                holds: None,
                board: Some((1, 2)),
                probe: WAITING_LINE,
                nets: EVEN,
            },
        ],
    )
}

#[test]
fn settling_claims_after_the_escrow_ends_against_every_board_state() -> TestResult {
    let forfeit = Ledger {
        owner: s(1),
        ..EVEN
    };
    let closed = |state, moved, nets| Case {
        state,
        expect: Done,
        moved,
        holds: None,
        board: None,
        probe: NO_BOARD,
        nets,
    };
    run(
        Event::SettleEnded,
        &[
            closed(State::Free, EVEN, EVEN),
            closed(State::Held, forfeit, FORFEITED),
            closed(State::Lapsed, forfeit, FORFEITED),
            closed(State::LineOfOne, forfeit, FORFEITED),
            closed(State::LineOfThree, forfeit, FORFEITED),
            closed(State::DroppedWithLine, EVEN, EVEN),
        ],
    )
}

#[test]
fn closing_the_escrow_against_every_board_state() -> TestResult {
    let kept = |state, holds, board, nets| Case {
        state,
        expect: Done,
        moved: EVEN,
        holds,
        board: Some(board),
        probe: NO_INTENT,
        nets,
    };
    run(
        Event::Close,
        &[
            kept(State::Free, None, (0, 0), EVEN),
            kept(State::Held, Some(Party::Holder), (0, 0), FORFEITED),
            kept(State::Lapsed, Some(Party::Holder), (0, 0), FORFEITED),
            kept(State::LineOfOne, Some(Party::Holder), (0, 1), FORFEITED),
            kept(State::LineOfThree, Some(Party::Holder), (0, 3), FORFEITED),
            kept(State::DroppedWithLine, None, (1, 2), EVEN),
        ],
    )
}
