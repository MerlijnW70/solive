use anchor_lang::prelude::Pubkey;
use intent_engine::events::ReviewLapsed;
use litesvm::types::TransactionMetadata;
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction_error::TransactionError;
use svm_tests::{
    book_pda, events, ClaimWorld, ReleasePath, TestResult, FAIR_DAY, FAIR_EXPIRY, FAIR_HOLD,
    FAIR_KILL, FAIR_REVIEW, FAIR_STAKE, FAIR_TERMS,
};

const SIGNATURE_FEE: u64 = 5_000;

#[derive(Clone, Copy, Debug)]
enum Step {
    Claim(usize),
    Announce(usize),
    Reject,
    RequestCancel,
    Cancel,
    Settle,
    Release,
    Drop(usize),
    Expire,
    BeforeReviewEnd,
    AtReviewEnd,
    AtExpiry,
    Forward(i64),
}

fn step() -> impl Strategy<Value = Step> {
    prop_oneof![
        (0usize..2).prop_map(Step::Claim),
        (0usize..2).prop_map(Step::Announce),
        Just(Step::Reject),
        Just(Step::RequestCancel),
        Just(Step::Cancel),
        Just(Step::Settle),
        Just(Step::Release),
        (0usize..2).prop_map(Step::Drop),
        Just(Step::Expire),
        Just(Step::BeforeReviewEnd),
        Just(Step::AtReviewEnd),
        Just(Step::AtExpiry),
        prop_oneof![Just(1i64), Just(3_600), Just(FAIR_DAY)].prop_map(Step::Forward),
    ]
}

fn ending() -> impl Strategy<Value = Vec<Step>> {
    prop_oneof![
        Just(vec![Step::AtReviewEnd, Step::Settle]),
        Just(vec![
            Step::RequestCancel,
            Step::Forward(FAIR_DAY),
            Step::AtReviewEnd,
            Step::Cancel
        ]),
        Just(vec![Step::AtExpiry, Step::Settle]),
        Just(vec![Step::AtExpiry, Step::Expire, Step::Settle]),
        Just(vec![Step::BeforeReviewEnd, Step::Reject]),
        Just(vec![Step::BeforeReviewEnd, Step::Release]),
        Just(vec![Step::Drop(0)]),
    ]
}

fn reviewed() -> impl Strategy<Value = Vec<Step>> {
    (
        prop::collection::vec(step(), 0..3),
        ending(),
        prop::collection::vec(step(), 0..10),
        ending(),
    )
        .prop_map(|(lead, first, middle, last)| {
            let mut steps = lead;
            steps.extend([Step::Claim(0), Step::Announce(0)]);
            steps.extend(first);
            steps.extend(middle);
            steps.extend([Step::Claim(1), Step::Announce(1)]);
            steps.extend(last);
            steps
        })
}

fn scenario() -> impl Strategy<Value = Vec<Step>> {
    prop_oneof![
        4 => reviewed(),
        1 => prop::collection::vec(step(), 1..24),
    ]
}

struct Run {
    w: ClaimWorld,
    workers: [Keypair; 2],
    kill_paid: u64,
}

fn landed(sent: &Result<TransactionMetadata, TransactionError>) -> Option<&TransactionMetadata> {
    sent.as_ref().ok()
}

impl Run {
    fn new() -> TestResult<Self> {
        let mut w = ClaimWorld::expiring(ReleasePath::Attested, FAIR_TERMS, FAIR_EXPIRY)?;
        w.open_review(FAIR_REVIEW, FAIR_STAKE, FAIR_REVIEW, FAIR_KILL)
            .map_err(|e| format!("open: {e:?}"))?;
        let workers = [
            w.release.workers[0].insecure_clone(),
            w.release.workers[1].insecure_clone(),
        ];
        Ok(Self {
            w,
            workers,
            kill_paid: 0,
        })
    }

    fn lamports(&self) -> u128 {
        let keys = [
            self.w.owner(),
            self.workers[0].pubkey(),
            self.workers[1].pubkey(),
            self.w.board_key(),
        ];
        keys.iter().map(|k| u128::from(self.w.lamports(k))).sum()
    }

    fn tokens(&self) -> TestResult<u128> {
        let r = &self.w.release;
        let accounts = [
            r.vault(),
            r.atas[0],
            r.atas[1],
            r.trader.input,
            r.fee_to,
            r.judge_to,
        ];
        let mut total = 0u128;
        for a in accounts {
            total = total.saturating_add(u128::from(r.env.balance(&a).unwrap_or(0)));
        }
        Ok(total)
    }

    fn armed(&self) -> bool {
        self.w.exists(&self.w.board_key()) && self.w.board().is_ok_and(|b| b.review_until != 0)
    }

    fn apply(&mut self, step: Step) -> TestResult<Option<u64>> {
        let book = book_pda(&self.w.intent());
        let book_before = self.w.lamports(&book);
        let board_open = self.w.exists(&self.w.board_key());
        if !board_open && matches!(step, Step::Settle | Step::Drop(_)) {
            return Ok(None);
        }
        let sent = match step {
            Step::Claim(i) => {
                let who = self.workers.get(i).ok_or("no worker")?.insecure_clone();
                self.w.claim(&who, FAIR_HOLD)
            }
            Step::Announce(i) => {
                let who = self.workers.get(i).ok_or("no worker")?.insecure_clone();
                let before = self.lamports();
                return match self.w.announce(&who) {
                    Ok(d) => {
                        let rent = self.w.lamports(&d.announcement);
                        let book_rent = self.w.lamports(&book).saturating_sub(book_before);
                        let cost = u128::from(rent)
                            .saturating_add(u128::from(book_rent))
                            .saturating_add(u128::from(SIGNATURE_FEE));
                        if self.lamports().saturating_add(cost) != before {
                            return Err(
                                "an announcement moved lamports beyond its own rent and fee".into(),
                            );
                        }
                        Ok(Some(0))
                    }
                    Err(_) => Ok(None),
                };
            }
            Step::Reject => match self.w.delivery {
                Some(d) => self.w.reject(&d)?,
                None => return Ok(None),
            },
            Step::RequestCancel => self.w.request_cancel(),
            Step::Cancel => {
                let worker = self.w.board().map(|b| b.worker).ok();
                let worker = worker.filter(|w| *w != Pubkey::default());
                self.w.cancel(worker.as_ref())
            }
            Step::Settle => self.w.settle()?,
            Step::Release => {
                if self.w.delivery.is_none() {
                    return Ok(None);
                }
                let worker = self.w.board().map(|b| b.worker).ok();
                let worker = worker.filter(|w| *w != Pubkey::default());
                self.w.release_to(ReleasePath::Attested, worker.as_ref())?
            }
            Step::Drop(i) => {
                let who = self.workers.get(i).ok_or("no worker")?.insecure_clone();
                self.w.drop_claim(&who)?
            }
            Step::Expire => self.w.expire(),
            Step::BeforeReviewEnd | Step::AtReviewEnd => {
                if let Ok(board) = self.w.board() {
                    if board.review_until != 0 {
                        let at = if matches!(step, Step::AtReviewEnd) {
                            board.review_until
                        } else {
                            board.review_until.saturating_sub(1)
                        };
                        self.w.set_now(at.max(self.w.now()));
                    }
                }
                return Ok(Some(0));
            }
            Step::AtExpiry => {
                self.w.set_now(FAIR_EXPIRY.max(self.w.now()));
                return Ok(Some(0));
            }
            Step::Forward(secs) => {
                let now = self.w.now();
                self.w.set_now(now.saturating_add(secs));
                return Ok(Some(0));
            }
        };
        let paid = landed(&sent).map(|meta| {
            events::<ReviewLapsed>(meta)
                .iter()
                .map(|e| e.kill_fee)
                .sum::<u64>()
        });
        Ok(paid)
    }

    fn check_board(&self) -> TestResult {
        if !self.w.exists(&self.w.board_key()) {
            return Ok(());
        }
        let b = self.w.board()?;
        let expected = self
            .w
            .board_rent()
            .saturating_add(b.held)
            .saturating_add(b.kill_fee);
        if self.w.lamports(&self.w.board_key()) != expected {
            return Err(
                "the board holds other than rent, the held stake and the unpaid kill fee".into(),
            );
        }
        if b.review_until != 0 && (b.worker == Pubkey::default() || b.review_until > FAIR_EXPIRY) {
            return Err("an armed review without a holder or past expiry".into());
        }
        Ok(())
    }
}

fn run(steps: &[Step]) -> TestResult {
    let mut r = Run::new()?;
    let tokens = r.tokens()?;
    for step in steps {
        let armed = r.armed();
        let before = r.lamports();
        let owner = r.w.lamports(&r.w.owner());
        let board_existed = r.w.exists(&r.w.board_key());
        let rent = r.w.board_rent();
        let paid = r.apply(*step)?;
        if let Some(fee) = paid {
            r.kill_paid = r.kill_paid.saturating_add(fee);
        }
        if !matches!(step, Step::Announce(_)) && r.lamports() != before {
            return Err(
                format!("{step:?} changed the lamports of owner, workers and board").into(),
            );
        }
        if r.tokens()? != tokens {
            return Err(format!("{step:?} changed the escrow's token total").into());
        }
        let gained = r.w.lamports(&r.w.owner()).saturating_sub(owner);
        let closed = board_existed && !r.w.exists(&r.w.board_key());
        if armed && gained > if closed { rent } else { 0 } {
            return Err(
                format!("{step:?} paid the owner {gained} while a review was armed").into(),
            );
        }
        if r.kill_paid > FAIR_KILL {
            return Err("the kill fee was paid more than once".into());
        }
        r.check_board()?;
    }
    r.w.set_now(FAIR_EXPIRY.max(r.w.now()));
    if r.w.exists(&r.w.board_key()) {
        r.w.settle()?
            .map_err(|e| format!("settle after expiry: {e:?}"))?;
    }
    if r.w.exists(&r.w.board_key()) {
        return Err("the board outlived expiry".into());
    }
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(
        std::env::var("FAIR_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(96)
    ))]

    #[test]
    fn lamports_and_tokens_are_conserved_and_no_review_pays_the_owner(
        steps in scenario(),
    ) {
        run(&steps).map_err(|e| TestCaseError::fail(e.to_string()))?;
    }
}

#[test]
fn a_scripted_lapse_conserves_everything() -> TestResult {
    run(&[
        Step::Claim(0),
        Step::Announce(0),
        Step::RequestCancel,
        Step::Forward(FAIR_DAY),
        Step::Cancel,
        Step::BeforeReviewEnd,
        Step::Settle,
        Step::AtReviewEnd,
        Step::Cancel,
        Step::Settle,
        Step::Claim(1),
        Step::AtExpiry,
        Step::Settle,
    ])
}
