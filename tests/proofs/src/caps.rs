use intent_core::mint_cap::{
    charge, give_back_since, refund_outstanding, take_back, Limits, Usage,
};

const INTENTS: usize = 2;
const STEPS: usize = 3;

struct Book {
    limits: Limits,
    usage: Usage,
    created_at: i64,
    capped: [u64; INTENTS],
    charged: [bool; INTENTS],
    born: [i64; INTENTS],
}

impl Book {
    fn open() -> Self {
        Self {
            limits: Limits {
                max_per_order: kani::any(),
                window_cap: kani::any(),
                window_secs: kani::any(),
                total_limit: kani::any(),
            },
            usage: Usage {
                window_start: kani::any(),
                window_used: kani::any(),
                outstanding: 0,
            },
            created_at: kani::any(),
            capped: [0; INTENTS],
            charged: [false; INTENTS],
            born: [0; INTENTS],
        }
    }

    fn live(&self) -> u128 {
        self.capped.iter().map(|&c| u128::from(c)).sum()
    }

    fn charge(&mut self, i: usize, amount: u64, now: i64) {
        if self.charged[i] || now < self.created_at {
            return;
        }
        let before = self.live();
        if let Ok(next) = charge(self.limits, self.usage, amount, now) {
            if self.limits.total_limit != 0 {
                assert!(next.outstanding <= self.limits.total_limit);
                assert!(before + u128::from(amount) <= u128::from(self.limits.total_limit));
            }
            assert!(amount <= self.limits.max_per_order);
            assert!(next.window_used <= self.limits.window_cap);
            self.usage = next;
            self.capped[i] = amount;
            self.charged[i] = true;
            self.born[i] = now;
        }
    }

    fn give_back(&mut self, i: usize, left: u64) {
        let returned = give_back_since(
            self.usage.outstanding,
            self.capped[i],
            left,
            self.created_at,
            self.born[i],
        );
        assert!(returned.is_ok());
        if let Ok(r) = returned {
            assert_eq!(r.counted, left.min(self.capped[i]));
            self.usage.outstanding = r.outstanding;
            self.capped[i] = r.capped;
        }
    }

    fn refund(&mut self, i: usize, left: u64) {
        let (counted, capped) = take_back(self.capped[i], left);
        self.capped[i] = capped;
        self.usage.outstanding = refund_outstanding(
            self.usage.outstanding,
            counted,
            self.created_at,
            self.born[i],
        );
    }
}

#[kani::proof]
#[kani::unwind(4)]
fn outstanding_equals_the_live_capped_amounts_and_stays_within_the_limit() {
    let mut book = Book::open();
    for _ in 0..STEPS {
        let i: usize = kani::any();
        kani::assume(i < INTENTS);
        let amount: u64 = kani::any();
        match kani::any::<u8>() % 3 {
            0 => book.charge(i, amount, kani::any()),
            1 => book.give_back(i, amount),
            _ => book.refund(i, amount),
        }
        assert_eq!(u128::from(book.usage.outstanding), book.live());
    }
}

#[kani::proof]
#[kani::unwind(4)]
fn after_refunds_a_charge_passes_only_within_the_live_total() {
    let mut book = Book::open();
    kani::assume(book.limits.total_limit != 0);
    for _ in 0..STEPS {
        let i: usize = kani::any();
        kani::assume(i < INTENTS);
        let amount: u64 = kani::any();
        if kani::any() {
            book.refund(i, amount);
        } else {
            let now: i64 = kani::any();
            let before = book.live();
            let passed = charge(book.limits, book.usage, amount, now).is_ok();
            book.charge(i, amount, now);
            if passed {
                assert!(before + u128::from(amount) <= u128::from(book.limits.total_limit));
            }
        }
    }
}

#[kani::proof]
#[kani::unwind(4)]
fn refunds_and_fills_of_older_intents_never_lower_a_recreated_cap_below_its_own_charges() {
    let mut book = Book::open();
    let old: [u64; INTENTS] = kani::any();
    let old_born: [i64; INTENTS] = kani::any();
    let mut old_capped = old;
    for _ in 0..STEPS {
        let i: usize = kani::any();
        kani::assume(i < INTENTS);
        let amount: u64 = kani::any();
        match kani::any::<u8>() % 5 {
            0 => book.charge(i, amount, kani::any()),
            1 => book.refund(i, amount),
            2 => book.give_back(i, amount),
            3 => {
                kani::assume(old_born[i] < book.created_at);
                let (counted, capped) = take_back(old_capped[i], amount);
                old_capped[i] = capped;
                book.usage.outstanding = refund_outstanding(
                    book.usage.outstanding,
                    counted,
                    book.created_at,
                    old_born[i],
                );
            }
            _ => {
                kani::assume(old_born[i] < book.created_at);
                let returned = give_back_since(
                    book.usage.outstanding,
                    old_capped[i],
                    amount,
                    book.created_at,
                    old_born[i],
                );
                assert!(returned.is_ok());
                if let Ok(r) = returned {
                    assert_eq!(r.counted, amount.min(old_capped[i]));
                    old_capped[i] = r.capped;
                    book.usage.outstanding = r.outstanding;
                }
            }
        }
        assert!(u128::from(book.usage.outstanding) >= book.live());
        assert_eq!(u128::from(book.usage.outstanding), book.live());
    }
}
